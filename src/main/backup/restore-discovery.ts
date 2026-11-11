import { createHash } from 'node:crypto';
import { addAbortSignal, Readable } from 'node:stream';

import { createDecryptStream, type KeyResolver } from '../crypto/envelope.js';
import { MIGRATIONS } from '../db/migrations.js';
import { parseBackupManifest, type RestorableBackupManifest } from './backup-manifest.js';
import { blobPhotos } from './backup-manifest-coverage.js';
import { openRecoveryBootstrap, recoveryBootstrapResolver, type RecoveryBootstrap } from './recovery-bootstrap.js';
import { ProviderError, type RemoteEntry, type StorageProvider } from './provider.js';
import { RestoreError, toRestoreError } from './restore-types.js';
import { manifestDerivativeKey } from './restore-variants.js';

const MAX_BOOTSTRAP_BYTES = 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
const MANIFEST_PATH = /^manifest\/gen-(\d+)\.ovlk$/u;
const CURRENT_DATABASE_SCHEMA = Math.max(...MIGRATIONS.map((migration) => migration.version));

export interface RestoreCandidate {
  readonly path: string;
  readonly generation: number;
  readonly sealedSha256: string;
  readonly manifest: RestorableBackupManifest;
}

export interface RestoreDiscovery {
  readonly bootstrap: RecoveryBootstrap;
  readonly resolveKey: KeyResolver;
  /** Highest advertised generation, even when its manifest is invalid. */
  readonly newestGeneration: number;
  readonly candidates: readonly RestoreCandidate[];
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw new RestoreError('cancelled', 'restore cancelled');
}

async function readLimited(stream: Readable, maximum: number, signal?: AbortSignal): Promise<Buffer> {
  const source = signal === undefined ? stream : addAbortSignal(signal, stream);
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const value of source) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
    length += chunk.length;
    if (length > maximum) {
      source.destroy();
      throw new RestoreError('corrupt', `remote object exceeds ${String(maximum)} bytes`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}

function generationOf(entry: RemoteEntry): number | null {
  const match = MANIFEST_PATH.exec(entry.path);
  if (match === null) return null;
  const generation = Number(match[1]);
  if (!Number.isSafeInteger(generation) || generation <= 0) {
    throw new RestoreError('corrupt', `invalid manifest generation path ${entry.path}`);
  }
  return generation;
}

function assertBootstrapGeneration(bootstrap: RecoveryBootstrap, newestGeneration: number): void {
  if (bootstrap.schema === 1) return;
  if (bootstrap.manifestGeneration === newestGeneration || bootstrap.manifestGeneration === newestGeneration + 1) return;
  if (bootstrap.manifestGeneration < newestGeneration) {
    throw new RestoreError('corrupt', 'recovery bootstrap predates the newest manifest generation');
  }
  throw new RestoreError('corrupt', 'recovery bootstrap and manifest generations are not contiguous');
}

function expectedManifestSha256(bootstrap: RecoveryBootstrap, generation: number): string | null | undefined {
  if (bootstrap.schema === 1) return undefined;
  if (generation === bootstrap.manifestGeneration) return bootstrap.manifestSha256;
  if (generation === bootstrap.previousManifest?.generation) return bootstrap.previousManifest.sha256;
  return null;
}

function validateManifest(manifest: RestorableBackupManifest, bootstrap: RecoveryBootstrap, resolveKey: KeyResolver): void {
  if (manifest.libraryId !== bootstrap.libraryId) {
    throw new RestoreError('corrupt', 'manifest library id does not match the recovery bootstrap');
  }
  if (manifest.databaseSchema > CURRENT_DATABASE_SCHEMA) {
    throw new RestoreError(
      'unsupported',
      `manifest database schema ${String(manifest.databaseSchema)} is newer than ${String(CURRENT_DATABASE_SCHEMA)}`,
    );
  }
  for (const keyId of manifest.keyIds) {
    if (resolveKey(keyId) === undefined) throw new RestoreError('wrong-key', `manifest key ${String(keyId)} is unavailable`);
  }
  const blobRefs = new Set<string>();
  const supportsVariants = 'variantFamilies' in manifest;
  for (const photo of blobPhotos(manifest.photos)) {
    const refKey = supportsVariants ? `${photo.blobPath}:${manifestDerivativeKey(photo)}` : photo.blobPath;
    if (blobRefs.has(refKey)) throw new RestoreError('corrupt', `duplicate blob reference ${photo.blobPath}`);
    blobRefs.add(refKey);
  }
}

async function openCandidate(
  provider: StorageProvider,
  entry: RemoteEntry,
  generation: number,
  bootstrap: RecoveryBootstrap,
  resolveKey: KeyResolver,
  expectedSha256: string | undefined,
  signal?: AbortSignal,
): Promise<RestoreCandidate> {
  assertNotAborted(signal);
  const sealed = await readLimited(await provider.getStream(entry.path), MAX_MANIFEST_BYTES, signal);
  const sealedSha256 = createHash('sha256').update(sealed).digest('hex');
  if (expectedSha256 !== undefined && sealedSha256 !== expectedSha256) {
    throw new RestoreError('corrupt', `${entry.path} does not match its authenticated recovery-bootstrap digest`);
  }
  let unavailableKeyId: number | null = null;
  const trackedResolver: KeyResolver = (keyId) => {
    const key = resolveKey(keyId);
    if (key === undefined) unavailableKeyId = keyId;
    return key;
  };
  let plaintext: Buffer;
  try {
    plaintext = await readLimited(
      Readable.from([sealed]).pipe(createDecryptStream(trackedResolver, { photoId: 'manifest' })),
      MAX_MANIFEST_BYTES,
      signal,
    );
  } catch (error) {
    if (unavailableKeyId !== null) {
      throw new RestoreError('wrong-key', `manifest key ${String(unavailableKeyId)} is unavailable`);
    }
    throw error;
  }
  let json: unknown;
  try {
    json = JSON.parse(plaintext.toString('utf8')) as unknown;
  } catch {
    throw new RestoreError('corrupt', `${entry.path} is not valid JSON`);
  }
  const parsed = parseBackupManifest(json);
  if (!parsed.restorable) throw new RestoreError('unsupported', `${entry.path} uses non-restorable schema 1`);
  validateManifest(parsed.manifest, bootstrap, resolveKey);
  return {
    path: entry.path,
    generation,
    sealedSha256,
    manifest: parsed.manifest,
  };
}

export async function discoverRestore(provider: StorageProvider, masterKey: Buffer, signal?: AbortSignal): Promise<RestoreDiscovery> {
  try {
    assertNotAborted(signal);
    if ((await provider.authState()) !== 'connected') throw new RestoreError('auth', 'backup provider is not connected');
    const bootstrapBytes = await readLimited(await provider.getStream('recovery/bootstrap.ovrb'), MAX_BOOTSTRAP_BYTES, signal);
    let bootstrap: RecoveryBootstrap;
    try {
      bootstrap = openRecoveryBootstrap(bootstrapBytes, masterKey);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const reason = /authentication|wrapped key/u.test(message) ? 'wrong-key' : 'corrupt';
      throw new RestoreError(reason, message);
    }
    const entries = (await provider.list('manifest'))
      .map((entry) => ({ entry, generation: generationOf(entry) }))
      .filter((item): item is { entry: RemoteEntry; generation: number } => item.generation !== null)
      .sort((left, right) => right.generation - left.generation);
    const newestGeneration = entries[0]?.generation;
    if (newestGeneration === undefined) throw new RestoreError('corrupt', 'no manifest generation was found');
    assertBootstrapGeneration(bootstrap, newestGeneration);
    const resolveKey = recoveryBootstrapResolver(bootstrap, masterKey);
    const candidates: RestoreCandidate[] = [];
    for (const { entry, generation } of entries) {
      const expectedSha256 = expectedManifestSha256(bootstrap, generation);
      if (expectedSha256 === null) continue;
      try {
        candidates.push(await openCandidate(provider, entry, generation, bootstrap, resolveKey, expectedSha256, signal));
      } catch (error) {
        const mapped = toRestoreError(error);
        if (
          mapped.reason === 'auth' ||
          mapped.reason === 'offline' ||
          (mapped.reason === 'wrong-key' && candidates.length === 0) ||
          (error instanceof ProviderError && error.kind === 'transient' && error.scope === 'object') ||
          mapped.reason === 'cancelled'
        ) {
          throw mapped;
        }
      }
    }
    if (candidates.length === 0) throw new RestoreError('corrupt', 'no valid restorable manifest generation was found');
    return { bootstrap, resolveKey, newestGeneration, candidates };
  } catch (error) {
    throw toRestoreError(error);
  }
}
