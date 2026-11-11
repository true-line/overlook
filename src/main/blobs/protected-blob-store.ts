import { createHash, createHmac, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { link, mkdir, rm } from 'node:fs/promises';
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
    if (!REF_PATTERN.test(contentHash)) throw new ProtectedBlobStoreError('content hash must be 64 lowercase hex characters');
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

  has(albumId: string, blobRef: string, kind: ProtectedBlobKind): boolean {
    return existsSync(this.path(albumId, blobRef, kind));
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

  async deleteBlob(albumId: string, blobRef: string): Promise<void> {
    for (const kind of ['original', 'thumb', 'mid'] as const) await rm(this.path(albumId, blobRef, kind), { force: true });
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
    assertAlbumKey(albumKey);
    const finalPath = this.path(albumId, blobRef, kind);
    const stagePath = join(this.stagingDir, `stage-${randomBytes(12).toString('hex')}`);
    const hasher = createHash('sha256');
    plaintext.on('data', (chunk: Buffer) => hasher.update(chunk));
    try {
      await pipeline(
        plaintext,
        createEncryptStream({ id: PROTECTED_ENVELOPE_KEY_ID, key: albumKey }, { photoId: this.envelopeContext(albumId, blobRef, kind) }),
        createWriteStream(stagePath, { flags: 'wx' }),
      );
      await syncFileData(stagePath);
      const plaintextHash = hasher.digest('hex');
      if (expectedHash !== undefined && plaintextHash !== expectedHash) {
        throw new ProtectedBlobStoreError(`protected ${kind} plaintext failed content-hash verification`);
      }
      await mkdir(dirname(finalPath), { recursive: true });
      try {
        await link(stagePath, finalPath);
      } catch (error) {
        if (!isErrno(error, 'EEXIST')) throw error;
        const existingHash = await this.plaintextHash(albumId, blobRef, kind, albumKey);
        if (existingHash !== plaintextHash) throw new ProtectedBlobStoreError(`protected ${kind} dedupe collision failed verification`);
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
    const hasher = createHash('sha256');
    try {
      for await (const chunk of this.getStream(albumId, blobRef, kind, albumKey)) hasher.update(chunk as Buffer);
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

  private path(albumId: string, blobRef: string, kind: ProtectedBlobKind): string {
    assertAlbumId(albumId);
    assertRef(blobRef);
    const albumRef = createHash('sha256').update(albumId, 'utf8').digest('hex');
    return join(this.blobsDir, albumRef.slice(0, 2), albumRef, `${blobRef}.${kind}`);
  }

  private envelopeContext(albumId: string, blobRef: string, kind: ProtectedBlobKind): string {
    return `protected:${albumId}:${blobRef}:${kind}`;
  }
}
