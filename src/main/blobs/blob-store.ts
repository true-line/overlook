import { createHash, randomBytes } from 'node:crypto';
import { closeSync, createReadStream, createWriteStream, existsSync, openSync, readSync } from 'node:fs';
import { link, mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import type { Readable } from 'node:stream';
import { addAbortSignal, pipeline as composeStreams } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { createDecryptStream, createEncryptStream } from '../crypto/envelope.js';
import { syncDirectoryEntry, syncFileData } from '../filesystem/durability.js';
import type { EnvelopeKey, KeyResolver } from '../crypto/envelope.js';

// Content-addressed encrypted blob store per ADR-0005 (#70). Plaintext never
// touches disk: bytes stream through the #67 envelope into tmp/, are fsynced,
// then atomically renamed to their hash-derived home. fsync policy: fsync the
// staged file before rename; fsync the destination directory after rename so
// the entry itself is durable (recorded per the issue).

export interface BlobRef {
  readonly contentHash: string;
  readonly keyId: number;
  readonly bytes: number;
}

export type ThumbSize = 'thumb' | 'mid';

export class BlobStoreError extends Error {
  override readonly name = 'BlobStoreError';
}

export interface BlobStoreOptions {
  /** Library data directory (ADR-0005 layout root). */
  readonly dataDir: string;
}

const HASH_PATTERN = /^[0-9a-f]{64}$/;

function assertHash(hash: string): void {
  if (!HASH_PATTERN.test(hash)) {
    throw new BlobStoreError('content hash must be 64 lowercase hex characters');
  }
}

function isErrno(error: unknown, code: string): boolean {
  // type-coverage:ignore-next-line -- narrowing the fs error shape
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function recursiveEntryPath(entry: { readonly name: string; readonly parentPath: string }): string {
  // Node 24 can surface an absolute Dirent.name for recursive reads on Windows.
  // Treat the resolved path as authoritative and derive logical names from it.
  return isAbsolute(entry.name) ? entry.name : join(entry.parentPath, entry.name);
}

/** Reads the key id out of an existing envelope header (magic|ver|keyId). */
async function readEnvelopeKeyId(path: string): Promise<number> {
  const handle = await open(path, 'r');
  try {
    const header = Buffer.alloc(9);
    await handle.read(header, 0, 9, 0);
    if (header.subarray(0, 4).toString('ascii') !== 'OVLK') {
      throw new BlobStoreError(`existing blob at ${path} is not an Overlook envelope`);
    }
    return header.readUInt32BE(5);
  } finally {
    await handle.close();
  }
}

export class BlobStore {
  private readonly blobsDir: string;
  private readonly thumbsDir: string;
  private readonly sidecarsDir: string;
  private readonly tmpDir: string;
  private readonly viewCacheDir: string;

  constructor(options: BlobStoreOptions) {
    this.blobsDir = join(options.dataDir, 'blobs');
    this.thumbsDir = join(options.dataDir, 'thumbs');
    this.sidecarsDir = join(options.dataDir, 'sidecars');
    this.tmpDir = join(options.dataDir, 'tmp');
    this.viewCacheDir = join(options.dataDir, 'ephemeral');
  }

  async init(): Promise<void> {
    await mkdir(this.blobsDir, { recursive: true });
    await mkdir(this.thumbsDir, { recursive: true });
    await mkdir(this.sidecarsDir, { recursive: true });
    await mkdir(this.tmpDir, { recursive: true });
    // Ephemeral viewing custody never survives a process lifetime. Clearing
    // first also recovers crashes during fetch, verify, or promotion.
    await rm(this.viewCacheDir, { recursive: true, force: true });
    await mkdir(this.viewCacheDir, { recursive: true });
  }

  private originalPath(contentHash: string): string {
    return join(this.blobsDir, contentHash.slice(0, 2), contentHash.slice(2, 4), contentHash);
  }

  /** Consistency-scan surface (#125): every original hash on disk, with
   * its age — imports publish the blob BEFORE inserting the row, so
   * callers must age-gate orphan classification (PR #223 review). */
  async listOriginalHashes(): Promise<{ hash: string; ageMs: number }[]> {
    const now = Date.now();
    const out: { hash: string; ageMs: number }[] = [];
    for (const entry of await readdir(this.blobsDir, { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) {
        const path = recursiveEntryPath(entry);
        const info = await stat(path);
        out.push({ hash: basename(path), ageMs: now - info.mtimeMs });
      }
    }
    return out;
  }

  /** Original hashes with at least one thumb on disk; age = the NEWEST
   * file's, so a fresh write protects the whole set. */
  async listThumbHashes(): Promise<{ hash: string; ageMs: number }[]> {
    const now = Date.now();
    const ages = new Map<string, number>();
    for (const entry of await readdir(this.thumbsDir, { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) {
        const path = recursiveEntryPath(entry);
        const hash = basename(path).replace(/\.(thumb|mid)$/u, '');
        const info = await stat(path);
        const ageMs = now - info.mtimeMs;
        ages.set(hash, Math.min(ages.get(hash) ?? Number.POSITIVE_INFINITY, ageMs));
      }
    }
    return [...ages.entries()].map(([hash, ageMs]) => ({ hash, ageMs }));
  }

  /** Staging entries with ages — a crash mid-put strands ciphertext in
   * tmp/, but LIVE puts stage here too; callers must age-gate (#125: the
   * startup repair once reaped the seeder's in-flight stage file). */
  async listStaged(): Promise<{ name: string; ageMs: number }[]> {
    const entries = (await readdir(this.tmpDir, { withFileTypes: true })).filter((entry) => entry.isFile());
    const now = Date.now();
    const out: { name: string; ageMs: number }[] = [];
    for (const entry of entries) {
      const info = await stat(join(this.tmpDir, entry.name));
      out.push({ name: entry.name, ageMs: now - info.mtimeMs });
    }
    return out;
  }

  async removeStaged(name: string): Promise<void> {
    await rm(join(this.tmpDir, name), { force: true });
  }

  private thumbPath(contentHash: string, size: ThumbSize): string {
    return join(this.thumbsDir, contentHash.slice(0, 2), `${contentHash}.${size}`);
  }

  // Companions retain their immutable import owner (#1120, ADR-0031 §3).
  // Callers resolve variant references before entering this byte store;
  // paths and envelope AAD stay bound to that owner after root purge.
  private sidecarDir(photoId: string): string {
    return join(this.sidecarsDir, photoId.slice(0, 2), photoId);
  }

  private sidecarPath(photoId: string, contentHash: string): string {
    return join(this.sidecarDir(photoId), contentHash);
  }

  private static sidecarContext(photoId: string): string {
    return `sidecar:${photoId}`;
  }

  /** Streams sidecar plaintext into the photo's encrypted companion set. */
  async putSidecar(plaintext: Readable, key: EnvelopeKey, photoId: string): Promise<BlobRef> {
    return this.put(plaintext, key, BlobStore.sidecarContext(photoId), (hash) => this.sidecarPath(photoId, hash));
  }

  hasSidecar(photoId: string, contentHash: string): boolean {
    assertHash(contentHash);
    return existsSync(this.sidecarPath(photoId, contentHash));
  }

  /** Reads the envelope key id of an on-disk companion so unprotect commit
   * records the true key when an existing shared sidecar envelope was kept. */
  sidecarKeyId(photoId: string, contentHash: string): number {
    assertHash(contentHash);
    const path = this.sidecarPath(photoId, contentHash);
    const fd = openSync(path, 'r');
    try {
      const header = Buffer.alloc(9);
      if (readSync(fd, header, 0, 9, 0) < 9 || header.subarray(0, 4).toString('ascii') !== 'OVLK') {
        throw new BlobStoreError(`existing sidecar at ${path} is not an Overlook envelope`);
      }
      return header.readUInt32BE(5);
    } finally {
      closeSync(fd);
    }
  }

  /** Decrypting read stream for one companion. */
  getSidecarStream(photoId: string, contentHash: string, resolveKey: KeyResolver): Readable {
    assertHash(contentHash);
    const path = this.sidecarPath(photoId, contentHash);
    if (!existsSync(path)) throw new BlobStoreError(`sidecar ${contentHash} of ${photoId} is not in the store`);
    return composeStreams(
      createReadStream(path),
      createDecryptStream(resolveKey, { photoId: BlobStore.sidecarContext(photoId) }),
      () => undefined,
    );
  }

  /** RAW ciphertext for backup upload (ADR-0007 encrypt-once). */
  getEncryptedSidecarStream(photoId: string, contentHash: string): Readable {
    assertHash(contentHash);
    const path = this.sidecarPath(photoId, contentHash);
    if (!existsSync(path)) throw new BlobStoreError(`sidecar ${contentHash} of ${photoId} is not in the store`);
    return createReadStream(path);
  }

  /** Full integrity walk of a companion: every auth tag + content address. */
  async verifySidecar(photoId: string, contentHash: string, resolveKey: KeyResolver): Promise<boolean> {
    assertHash(contentHash);
    const path = this.sidecarPath(photoId, contentHash);
    if (!existsSync(path)) return false;
    return this.verifyEnvelopePath(path, contentHash, resolveKey, BlobStore.sidecarContext(photoId));
  }

  /** Restore a companion from provider ciphertext: stage → fsync → link →
   * verify-before-count, mirroring restoreOriginal. */
  async restoreSidecar(photoId: string, contentHash: string, ciphertext: Readable, resolveKey: KeyResolver): Promise<void> {
    assertHash(contentHash);
    const stagePath = join(this.tmpDir, `restore-${randomBytes(8).toString('hex')}`);
    try {
      await pipeline(ciphertext, createWriteStream(stagePath, { flags: 'wx' }));
      await syncFileData(stagePath);
      if (!(await this.verifyEnvelopePath(stagePath, contentHash, resolveKey, BlobStore.sidecarContext(photoId)))) {
        throw new BlobStoreError(`restored sidecar ${contentHash} of ${photoId} failed verification`);
      }
      const finalPath = this.sidecarPath(photoId, contentHash);
      await mkdir(dirname(finalPath), { recursive: true });
      let existed = false;
      try {
        await link(stagePath, finalPath);
      } catch (error) {
        if (!isErrno(error, 'EEXIST')) throw error;
        existed = true;
      }
      await rm(stagePath, { force: true });
      if (existed && !(await this.verifySidecar(photoId, contentHash, resolveKey))) {
        throw new BlobStoreError(`restored sidecar ${contentHash} of ${photoId} failed verification`);
      }
      await syncDirectoryEntry(dirname(finalPath));
    } catch (error) {
      await rm(stagePath, { force: true });
      throw error;
    }
  }

  /** Removes a single corrupt companion file without disturbing valid siblings on the same owner. */
  async deleteSidecar(photoId: string, contentHash: string): Promise<void> {
    assertHash(contentHash);
    await rm(this.sidecarPath(photoId, contentHash), { force: true });
  }

  /** Removes the photo's entire companion set — purge travels with the
   * owning photo (#484). */
  async deleteSidecars(photoId: string): Promise<void> {
    await rm(this.sidecarDir(photoId), { recursive: true, force: true });
  }

  /** Consistency-scan surface: every (photoId, hash) companion on disk with
   * its age — same age-gating contract as listOriginalHashes. */
  async listSidecarEntries(): Promise<{ photoId: string; hash: string; ageMs: number }[]> {
    const now = Date.now();
    const out: { photoId: string; hash: string; ageMs: number }[] = [];
    for (const entry of await readdir(this.sidecarsDir, { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) {
        const path = recursiveEntryPath(entry);
        const info = await stat(path);
        out.push({ photoId: basename(dirname(path)), hash: basename(path), ageMs: now - info.mtimeMs });
      }
    }
    return out;
  }

  /** Streams plaintext into an encrypted, content-addressed original.
   * Recovery supplies the recorded hash: verify the same bytes we encrypted
   * before publishing, without a second file read or a plaintext buffer. */
  async putOriginal(plaintext: Readable, key: EnvelopeKey, photoId: string, expectedContentHash?: string): Promise<BlobRef> {
    if (expectedContentHash !== undefined) assertHash(expectedContentHash);
    return this.put(plaintext, key, photoId, (hash) => {
      if (expectedContentHash !== undefined && hash !== expectedContentHash) {
        throw new BlobStoreError('recovery bytes do not match the recorded original');
      }
      return this.originalPath(hash);
    });
  }

  /** Same envelope path for derivatives; addressed by ORIGINAL hash + size. */
  async putThumb(plaintext: Readable, key: EnvelopeKey, photoId: string, originalHash: string, size: ThumbSize): Promise<BlobRef> {
    assertHash(originalHash);
    return this.put(plaintext, key, photoId, () => this.thumbPath(originalHash, size));
  }

  /** Atomically replaces a derivative envelope after a repair decoded the
   * original again. Originals always retain no-replace custody semantics. */
  async replaceThumb(plaintext: Readable, key: EnvelopeKey, photoId: string, originalHash: string, size: ThumbSize): Promise<BlobRef> {
    assertHash(originalHash);
    return this.put(plaintext, key, photoId, () => this.thumbPath(originalHash, size), true);
  }

  private async put(
    plaintext: Readable,
    key: EnvelopeKey,
    photoId: string,
    destination: (contentHash: string) => string,
    replace = false,
  ): Promise<BlobRef> {
    const stagePath = join(this.tmpDir, `stage-${randomBytes(8).toString('hex')}`);
    const hasher = createHash('sha256');
    let plainBytes = 0;
    plaintext.on('data', (chunk: Buffer) => {
      hasher.update(chunk);
      plainBytes += chunk.length;
    });

    const out = createWriteStream(stagePath, { flags: 'wx' });
    try {
      await pipeline(plaintext, createEncryptStream(key, { photoId }), out);
      // Durability point 1: the staged ciphertext itself.
      await syncFileData(stagePath);
      const contentHash = hasher.digest('hex');
      const finalPath = destination(contentHash);
      await mkdir(dirname(finalPath), { recursive: true });
      if (replace) {
        await rename(stagePath, finalPath);
        await syncDirectoryEntry(dirname(finalPath));
        return { contentHash, keyId: key.id, bytes: plainBytes };
      }
      // Atomic no-replace publish: link() fails with EEXIST instead of
      // clobbering. A collision means these bytes are already stored under
      // an envelope whose AAD binds the ORIGINAL photo id — replacing it
      // would orphan that row's decrypts (PR #150 review). Keep the existing
      // envelope and report its true key id.
      try {
        await link(stagePath, finalPath);
      } catch (error) {
        if (isErrno(error, 'EEXIST')) {
          await rm(stagePath, { force: true });
          return { contentHash, keyId: await readEnvelopeKeyId(finalPath), bytes: plainBytes };
        }
        throw error;
      }
      await rm(stagePath, { force: true });
      // Durability point 2: the directory entry.
      await syncDirectoryEntry(dirname(finalPath));
      return { contentHash, keyId: key.id, bytes: plainBytes };
    } catch (error) {
      await rm(stagePath, { force: true });
      throw error;
    }
  }

  hasOriginal(contentHash: string): boolean {
    assertHash(contentHash);
    return existsSync(this.originalPath(contentHash));
  }

  /** Rehydrate restore (#107): RAW ciphertext lands staged, links into the
   * store (no-replace), and MUST verify (decrypt + re-hash against the
   * content address) before it counts — a bad download never publishes. */
  async restoreOriginal(contentHash: string, ciphertext: Readable, resolveKey: KeyResolver, photoId: string): Promise<void> {
    assertHash(contentHash);
    const stagePath = join(this.tmpDir, `restore-${randomBytes(8).toString('hex')}`);
    try {
      await pipeline(ciphertext, createWriteStream(stagePath, { flags: 'wx' }));
      // Same durability point as put(): the staged bytes themselves fsync
      // BEFORE publishing — a power loss never leaves a present-but-
      // incomplete blob behind a synced ledger row (PR #205 review).
      await syncFileData(stagePath);
      if (!(await this.verifyEnvelopePath(stagePath, contentHash, resolveKey, photoId))) {
        throw new BlobStoreError(`restored blob ${contentHash} failed verification`);
      }
      const finalPath = this.originalPath(contentHash);
      await mkdir(dirname(finalPath), { recursive: true });
      let existed = false;
      try {
        await link(stagePath, finalPath);
      } catch (error) {
        if (!isErrno(error, 'EEXIST')) {
          throw error;
        }
        existed = true;
      }
      await rm(stagePath, { force: true });
      if (existed && !(await this.verifyOriginal(contentHash, resolveKey, photoId))) {
        throw new BlobStoreError(`restored blob ${contentHash} failed verification`);
      }
      await syncDirectoryEntry(dirname(finalPath));
    } catch (error) {
      await rm(stagePath, { force: true });
      throw error;
    }
  }

  /** Stores provider ciphertext in process-lifetime custody only. The
   * envelope is fully authenticated and its plaintext content address is
   * checked before the cache entry becomes visible. */
  async stageEphemeralOriginal(contentHash: string, ciphertext: Readable, resolveKey: KeyResolver, photoId: string): Promise<number> {
    assertHash(contentHash);
    const stagePath = join(this.viewCacheDir, `stage-${randomBytes(8).toString('hex')}`);
    const finalPath = join(this.viewCacheDir, contentHash);
    try {
      await pipeline(ciphertext, createWriteStream(stagePath, { flags: 'wx' }));
      await syncFileData(stagePath);
      if (!(await this.verifyEnvelopePath(stagePath, contentHash, resolveKey, photoId))) {
        throw new BlobStoreError(`ephemeral blob ${contentHash} failed verification`);
      }
      try {
        await link(stagePath, finalPath);
      } catch (error) {
        if (!isErrno(error, 'EEXIST')) throw error;
      }
      await rm(stagePath, { force: true });
      await syncDirectoryEntry(this.viewCacheDir);
      return (await stat(finalPath)).size;
    } catch (error) {
      await rm(stagePath, { force: true });
      throw error;
    }
  }

  hasEphemeralOriginal(contentHash: string): boolean {
    assertHash(contentHash);
    return existsSync(join(this.viewCacheDir, contentHash));
  }

  getEphemeralStream(contentHash: string, resolveKey: KeyResolver, photoId: string): Readable {
    assertHash(contentHash);
    const path = join(this.viewCacheDir, contentHash);
    if (!existsSync(path)) throw new BlobStoreError(`ephemeral blob ${contentHash} is not available`);
    return createReadStream(path).pipe(createDecryptStream(resolveKey, { photoId }));
  }

  /** Atomically adds an already verified ephemeral envelope to durable
   * custody. The cache link remains until its viewer releases it. */
  async promoteEphemeralOriginal(contentHash: string): Promise<void> {
    assertHash(contentHash);
    const source = join(this.viewCacheDir, contentHash);
    if (!existsSync(source)) throw new BlobStoreError(`ephemeral blob ${contentHash} is not available`);
    const destination = this.originalPath(contentHash);
    await mkdir(dirname(destination), { recursive: true });
    try {
      await link(source, destination);
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) throw error;
    }
    await syncDirectoryEntry(dirname(destination));
  }

  async deleteEphemeralOriginal(contentHash: string): Promise<void> {
    assertHash(contentHash);
    await rm(join(this.viewCacheDir, contentHash), { force: true });
  }

  /** RAW ciphertext stream for an original — backup uploads envelopes
   * as-is (ADR-0007 encrypt-once); never decrypts. */
  getEncryptedStream(contentHash: string): Readable {
    assertHash(contentHash);
    const path = this.originalPath(contentHash);
    if (!existsSync(path)) {
      throw new BlobStoreError(`blob ${contentHash} is not in the store`);
    }
    return createReadStream(path);
  }

  /** Decrypting read stream for an original. */
  getStream(contentHash: string, resolveKey: KeyResolver, photoId: string): Readable {
    assertHash(contentHash);
    const path = this.originalPath(contentHash);
    if (!existsSync(path)) {
      throw new BlobStoreError(`blob ${contentHash} is not in the store`);
    }
    // Composed with pipeline, not pipe: a consumer that stops early (a bounded
    // provenance read, an aborted restore) destroys the file stream too, so
    // no descriptor lingers until GC, and a read error reaches the consumer.
    return composeStreams(createReadStream(path), createDecryptStream(resolveKey, { photoId }), () => undefined);
  }

  getThumbStream(originalHash: string, size: ThumbSize, resolveKey: KeyResolver, photoId: string): Readable {
    assertHash(originalHash);
    const path = this.thumbPath(originalHash, size);
    if (!existsSync(path)) {
      throw new BlobStoreError(`thumb ${originalHash}.${size} is not in the store`);
    }
    return createReadStream(path).pipe(createDecryptStream(resolveKey, { photoId }));
  }

  hasThumbs(originalHash: string): boolean {
    assertHash(originalHash);
    return existsSync(this.thumbPath(originalHash, 'thumb')) && existsSync(this.thumbPath(originalHash, 'mid'));
  }

  /** Resume validation for restore-generated derivatives (#288). Their
   * plaintext is derived and has no catalog hash, so GCM authentication of
   * both complete envelopes is the integrity gate. */
  async verifyThumbs(originalHash: string, resolveKey: KeyResolver, photoId: string): Promise<boolean> {
    if (!this.hasThumbs(originalHash)) return false;
    try {
      for (const size of ['thumb', 'mid'] as const) {
        for await (const _chunk of this.getThumbStream(originalHash, size, resolveKey, photoId)) {
          // Drain every authenticated envelope chunk.
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  async deleteOriginal(contentHash: string): Promise<void> {
    assertHash(contentHash);
    await rm(this.originalPath(contentHash), { force: true });
  }

  async deleteThumbs(originalHash: string): Promise<void> {
    assertHash(originalHash);
    await rm(this.thumbPath(originalHash, 'thumb'), { force: true });
    await rm(this.thumbPath(originalHash, 'mid'), { force: true });
  }

  /** Full integrity walk: decrypts the blob (every auth tag) and re-checks
   * the content address. */
  async verifyOriginal(contentHash: string, resolveKey: KeyResolver, photoId: string, signal?: AbortSignal): Promise<boolean> {
    assertHash(contentHash);
    const hasher = createHash('sha256');
    try {
      signal?.throwIfAborted();
      const stream = this.getStream(contentHash, resolveKey, photoId);
      if (signal !== undefined) addAbortSignal(signal, stream);
      // type-coverage:ignore-next-line -- Readable yields untyped chunks
      for await (const chunk of stream) {
        // type-coverage:ignore-next-line -- Readable yields untyped chunks
        hasher.update(chunk as Buffer);
      }
    } catch {
      return false;
    }
    return hasher.digest('hex') === contentHash;
  }

  private async verifyEnvelopePath(path: string, contentHash: string, resolveKey: KeyResolver, photoId: string): Promise<boolean> {
    const hasher = createHash('sha256');
    try {
      const stream = createReadStream(path).pipe(createDecryptStream(resolveKey, { photoId }));
      for await (const chunk of stream) {
        hasher.update(chunk as Buffer);
      }
    } catch {
      return false;
    }
    return hasher.digest('hex') === contentHash;
  }

  /** Repair-story helper (M11): staging leftovers + originals not in `known`. */
  async scanOrphans(known: ReadonlySet<string>): Promise<{ staged: string[]; unknown: string[] }> {
    const staged = (await readdir(this.tmpDir)).map((name) => join(this.tmpDir, name));
    const unknown: string[] = [];
    for (const level1 of await readdir(this.blobsDir).catch(() => [] as string[])) {
      for (const level2 of await readdir(join(this.blobsDir, level1)).catch(() => [] as string[])) {
        for (const file of await readdir(join(this.blobsDir, level1, level2)).catch(() => [] as string[])) {
          if (!known.has(file)) {
            unknown.push(join(this.blobsDir, level1, level2, file));
          }
        }
      }
    }
    return { staged, unknown };
  }
}
