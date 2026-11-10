import { createHash, createHmac, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { link, mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { createDecryptStream, createEncryptStream } from '../crypto/envelope.js';
import { syncDirectoryEntry, syncFileData } from '../filesystem/durability.js';

export type ProtectedBlobKind = 'original' | 'thumb' | 'mid';

export class ProtectedBlobStoreError extends Error {
  override readonly name = 'ProtectedBlobStoreError';
}

const REF_PATTERN = /^[0-9a-f]{64}$/;
const PROTECTED_ENVELOPE_KEY_ID = 1;

function assertAlbumId(albumId: string): void {
  if (albumId.length < 1 || albumId.length > 256) throw new ProtectedBlobStoreError('album id is invalid');
}

function assertAlbumKey(albumKey: Buffer): void {
  if (albumKey.length !== 32) throw new ProtectedBlobStoreError('protected album key must be 32 bytes');
}

function assertRef(blobRef: string): void {
  if (!REF_PATTERN.test(blobRef)) throw new ProtectedBlobStoreError('protected blob reference must be 64 lowercase hex characters');
}

function assertHash(contentHash: string): void {
  if (!REF_PATTERN.test(contentHash)) throw new ProtectedBlobStoreError('content hash must be 64 lowercase hex characters');
}

function isErrno(error: unknown, code: string): boolean {
  // type-coverage:ignore-next-line -- narrowing the fs error shape
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

export class ProtectedBlobStore {
  private readonly blobsDir: string;
  private readonly stagingDir: string;

  constructor(dataDir: string) {
    this.blobsDir = join(dataDir, 'protected-blobs');
    this.stagingDir = join(dataDir, 'protected-tmp');
  }

  async init(): Promise<void> {
    await mkdir(this.blobsDir, { recursive: true });
    await mkdir(this.stagingDir, { recursive: true });
  }

  /** HMAC hides the ordinary plaintext content hash and scopes equality to A. */
  opaqueRef(albumKey: Buffer, contentHash: string, variantId?: string): string {
    assertAlbumKey(albumKey);
    assertHash(contentHash);
    if (variantId !== undefined) {
      if (variantId.length === 0 || variantId.length > 256) throw new ProtectedBlobStoreError('variant id is invalid');
      return createHmac('sha256', albumKey)
        .update(JSON.stringify(['overlook-protected-variant-v2', contentHash, variantId]), 'utf8')
        .digest('hex');
    }
    return createHmac('sha256', albumKey).update('overlook-protected-blob-v1\0', 'utf8').update(contentHash, 'ascii').digest('hex');
  }

  async putOriginal(input: {
    readonly albumId: string;
    readonly albumKey: Buffer;
    readonly contentHash: string;
    readonly variantId?: string;
    readonly plaintext: Readable;
  }): Promise<string> {
    const blobRef = this.opaqueRef(input.albumKey, input.contentHash, input.variantId);
    await this.put(input.albumId, blobRef, 'original', input.albumKey, input.plaintext, input.contentHash);
    return blobRef;
  }

  async putDerivative(input: {
    readonly albumId: string;
    readonly albumKey: Buffer;
    readonly blobRef: string;
    readonly kind: Exclude<ProtectedBlobKind, 'original'>;
    readonly plaintext: Readable;
  }): Promise<void> {
    await this.put(input.albumId, input.blobRef, input.kind, input.albumKey, input.plaintext);
  }

  async putSidecar(input: {
    readonly albumId: string;
    readonly albumKey: Buffer;
    readonly blobRef: string;
    readonly sidecarHash: string;
    readonly plaintext: Readable;
  }): Promise<void> {
    const finalPath = this.sidecarPath(input.albumId, input.blobRef, input.sidecarHash);
    const context = this.sidecarEnvelopeContext(input.albumId, input.blobRef, input.sidecarHash);
    await this.putAtPath(finalPath, context, 'sidecar', input.albumKey, input.plaintext, input.sidecarHash);
  }

  has(albumId: string, blobRef: string, kind: ProtectedBlobKind): boolean {
    return existsSync(this.path(albumId, blobRef, kind));
  }

  hasSidecar(albumId: string, blobRef: string, sidecarHash: string): boolean {
    return existsSync(this.sidecarPath(albumId, blobRef, sidecarHash));
  }

  getStream(albumId: string, blobRef: string, kind: ProtectedBlobKind, albumKey: Buffer): Readable {
    assertAlbumKey(albumKey);
    const path = this.path(albumId, blobRef, kind);
    if (!existsSync(path)) throw new ProtectedBlobStoreError(`protected ${kind} is not in the store`);
    return createReadStream(path).pipe(
      createDecryptStream((keyId) => (keyId === PROTECTED_ENVELOPE_KEY_ID ? albumKey : undefined), {
        photoId: this.envelopeContext(albumId, blobRef, kind),
      }),
    );
  }

  getSidecarStream(albumId: string, blobRef: string, sidecarHash: string, albumKey: Buffer): Readable {
    assertAlbumKey(albumKey);
    const path = this.sidecarPath(albumId, blobRef, sidecarHash);
    if (!existsSync(path)) throw new ProtectedBlobStoreError('protected sidecar is not in the store');
    return createReadStream(path).pipe(
      createDecryptStream((keyId) => (keyId === PROTECTED_ENVELOPE_KEY_ID ? albumKey : undefined), {
        photoId: this.sidecarEnvelopeContext(albumId, blobRef, sidecarHash),
      }),
    );
  }

  /** Raw encrypted envelope for provider upload; no album authority or
   * plaintext enters the provider adapter. */
  getEncryptedStream(albumId: string, blobRef: string, kind: ProtectedBlobKind): Readable {
    const path = this.path(albumId, blobRef, kind);
    if (!existsSync(path)) throw new ProtectedBlobStoreError(`protected ${kind} is not in the store`);
    return createReadStream(path);
  }

  async ciphertextInfo(
    albumId: string,
    blobRef: string,
    kind: ProtectedBlobKind,
  ): Promise<{ readonly sha256: string; readonly bytes: number }> {
    return this.encryptedDigest(this.getEncryptedStream(albumId, blobRef, kind));
  }

  /** Fresh-machine restore publishes only ciphertext whose digest is bound
   * by the authenticated manifest. Album keys remain closed. */
  async restoreEncrypted(input: {
    readonly albumId: string;
    readonly blobRef: string;
    readonly kind: ProtectedBlobKind;
    readonly ciphertext: Readable;
    readonly sha256: string;
    readonly bytes: number;
  }): Promise<void> {
    const finalPath = this.path(input.albumId, input.blobRef, input.kind);
    const stagePath = join(this.stagingDir, `restore-${randomBytes(12).toString('hex')}`);
    const hasher = createHash('sha256');
    let bytes = 0;
    input.ciphertext.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      hasher.update(chunk);
    });
    try {
      await pipeline(input.ciphertext, createWriteStream(stagePath, { flags: 'wx' }));
      await syncFileData(stagePath);
      const sha256 = hasher.digest('hex');
      if (sha256 !== input.sha256 || bytes !== input.bytes) {
        throw new ProtectedBlobStoreError(`protected ${input.kind} ciphertext failed manifest verification`);
      }
      await mkdir(dirname(finalPath), { recursive: true });
      try {
        await link(stagePath, finalPath);
      } catch (error) {
        if (!isErrno(error, 'EEXIST')) throw error;
        const existing = await this.ciphertextInfo(input.albumId, input.blobRef, input.kind);
        if (existing.sha256 !== sha256 || existing.bytes !== bytes) {
          throw new ProtectedBlobStoreError(`protected ${input.kind} restore conflicts with existing ciphertext`);
        }
      }
      await rm(stagePath, { force: true });
      await syncDirectoryEntry(dirname(finalPath));
    } catch (error) {
      await rm(stagePath, { force: true });
      throw error;
    }
  }

  async verify(albumId: string, blobRef: string, kind: ProtectedBlobKind, albumKey: Buffer, expectedHash?: string): Promise<boolean> {
    const hash = await this.plaintextHash(albumId, blobRef, kind, albumKey);
    return hash !== undefined && (expectedHash === undefined || hash === expectedHash);
  }

  async verifySidecar(albumId: string, blobRef: string, sidecarHash: string, albumKey: Buffer): Promise<boolean> {
    const hash = await this.sidecarPlaintextHash(albumId, blobRef, sidecarHash, albumKey);
    return hash === sidecarHash;
  }

  async deleteBlob(albumId: string, blobRef: string): Promise<void> {
    for (const kind of ['original', 'thumb', 'mid'] as const) await rm(this.path(albumId, blobRef, kind), { force: true });
    const dir = this.albumDir(albumId);
    const prefix = `${blobRef}.sidecar.`;
    try {
      for (const name of await readdir(dir)) {
        if (name.startsWith(prefix)) await rm(join(dir, name), { force: true });
      }
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error;
    }
  }

  async deleteKind(albumId: string, blobRef: string, kind: ProtectedBlobKind): Promise<void> {
    await rm(this.path(albumId, blobRef, kind), { force: true });
  }

  private async put(
    albumId: string,
    blobRef: string,
    kind: ProtectedBlobKind,
    albumKey: Buffer,
    plaintext: Readable,
    expectedHash?: string,
  ): Promise<void> {
    await this.putAtPath(
      this.path(albumId, blobRef, kind),
      this.envelopeContext(albumId, blobRef, kind),
      kind,
      albumKey,
      plaintext,
      expectedHash,
    );
  }

  private async putAtPath(
    finalPath: string,
    envelopeContext: string,
    label: string,
    albumKey: Buffer,
    plaintext: Readable,
    expectedHash?: string,
  ): Promise<void> {
    assertAlbumKey(albumKey);
    const stagePath = join(this.stagingDir, `stage-${randomBytes(12).toString('hex')}`);
    const hasher = createHash('sha256');
    plaintext.on('data', (chunk: Buffer) => hasher.update(chunk));
    try {
      await pipeline(
        plaintext,
        createEncryptStream({ id: PROTECTED_ENVELOPE_KEY_ID, key: albumKey }, { photoId: envelopeContext }),
        createWriteStream(stagePath, { flags: 'wx' }),
      );
      await syncFileData(stagePath);
      const plaintextHash = hasher.digest('hex');
      if (expectedHash !== undefined && plaintextHash !== expectedHash) {
        throw new ProtectedBlobStoreError(`protected ${label} plaintext failed content-hash verification`);
      }
      await mkdir(dirname(finalPath), { recursive: true });
      try {
        await link(stagePath, finalPath);
      } catch (error) {
        if (!isErrno(error, 'EEXIST')) throw error;
        const existingHash = await this.streamPlaintextHash(finalPath, envelopeContext, albumKey);
        if (existingHash !== plaintextHash) throw new ProtectedBlobStoreError(`protected ${label} dedupe collision failed verification`);
      }
      await rm(stagePath, { force: true });
      await syncDirectoryEntry(dirname(finalPath));
    } catch (error) {
      await rm(stagePath, { force: true });
      throw error;
    }
  }

  private async plaintextHash(albumId: string, blobRef: string, kind: ProtectedBlobKind, albumKey: Buffer): Promise<string | undefined> {
    if (!this.has(albumId, blobRef, kind)) return undefined;
    return this.streamPlaintextHash(this.path(albumId, blobRef, kind), this.envelopeContext(albumId, blobRef, kind), albumKey);
  }

  private async sidecarPlaintextHash(albumId: string, blobRef: string, sidecarHash: string, albumKey: Buffer): Promise<string | undefined> {
    if (!this.hasSidecar(albumId, blobRef, sidecarHash)) return undefined;
    return this.streamPlaintextHash(
      this.sidecarPath(albumId, blobRef, sidecarHash),
      this.sidecarEnvelopeContext(albumId, blobRef, sidecarHash),
      albumKey,
    );
  }

  private async streamPlaintextHash(filePath: string, envelopeContext: string, albumKey: Buffer): Promise<string | undefined> {
    assertAlbumKey(albumKey);
    const hasher = createHash('sha256');
    try {
      const decrypted = createReadStream(filePath).pipe(
        createDecryptStream((keyId) => (keyId === PROTECTED_ENVELOPE_KEY_ID ? albumKey : undefined), { photoId: envelopeContext }),
      );
      for await (const chunk of decrypted) hasher.update(chunk as Buffer);
      return hasher.digest('hex');
    } catch {
      return undefined;
    }
  }

  private async encryptedDigest(stream: Readable): Promise<{ readonly sha256: string; readonly bytes: number }> {
    const hasher = createHash('sha256');
    let bytes = 0;
    stream.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
    });
    await pipeline(stream, hasher);
    return { sha256: hasher.digest('hex'), bytes };
  }

  private albumDir(albumId: string): string {
    assertAlbumId(albumId);
    const albumRef = createHash('sha256').update(albumId, 'utf8').digest('hex');
    return join(this.blobsDir, albumRef.slice(0, 2), albumRef);
  }

  private path(albumId: string, blobRef: string, kind: ProtectedBlobKind): string {
    assertRef(blobRef);
    return join(this.albumDir(albumId), `${blobRef}.${kind}`);
  }

  private sidecarPath(albumId: string, blobRef: string, sidecarHash: string): string {
    assertRef(blobRef);
    assertHash(sidecarHash);
    return join(this.albumDir(albumId), `${blobRef}.sidecar.${sidecarHash}`);
  }

  private envelopeContext(albumId: string, blobRef: string, kind: ProtectedBlobKind): string {
    return `protected:${albumId}:${blobRef}:${kind}`;
  }

  private sidecarEnvelopeContext(albumId: string, blobRef: string, sidecarHash: string): string {
    return `protected:${albumId}:${blobRef}:sidecar:${sidecarHash}`;
  }
}
