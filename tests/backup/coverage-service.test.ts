import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { BlobStore } from '../../src/main/blobs/blob-store.js';
import { BackupEngine, type BackupEngineDeps } from '../../src/main/backup/backup-engine.js';
import { CoverageAuthorizationError, CoverageService } from '../../src/main/backup/coverage-service.js';
import { MockProvider } from '../../src/main/backup/mock-provider.js';
import { ProviderError } from '../../src/main/backup/provider.js';
import { SyncLedger } from '../../src/main/backup/sync-ledger.js';
import { CoverageRepository } from '../../src/main/db/coverage-repository.js';
import { openLibraryDatabase } from '../../src/main/db/database.js';
import { PhotosRepository } from '../../src/main/db/photos-repository.js';
import { VariantRepository } from '../../src/main/db/variant-repository.js';
import { run } from '../../src/main/db/sql.js';
import { sampleJpeg } from '../../src/main/library/seed.js';
import type { EnvelopeKey } from '../../src/main/crypto/envelope.js';
import { REMOVE_CLOUD_COPY_AUTHORIZATION } from '../../src/shared/destructive-actions.js';
import type { PhotoInsert, SyncStatus } from '../../src/shared/library/types.js';

// #506 / ADR-0033 over the real store, ledger, engine and mock provider:
// the §2 order (local custody → durable excluding → recording manifest →
// provider delete → excluded), the §3 shared-bytes gate, the §6 removal-
// pending retry, the §7 authorization tiers, and §5 re-enabling.

class FlakyProvider extends MockProvider {
  failDeletes = false;
  deletes: string[] = [];

  override async delete(path: string): Promise<void> {
    this.deletes.push(path);
    if (this.failDeletes) throw new ProviderError('simulated outage', 'transient');
    await super.delete(path);
  }
}

function remoteBlobs(rootDir: string): string[] {
  try {
    return readdirSync(join(rootDir, 'blobs'), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function world(spec: readonly { readonly id: string; readonly sample: number }[]) {
  const dataDir = mkdtempSync(join(tmpdir(), 'overlook-coverage-'));
  const db = openLibraryDatabase({ path: join(dataDir, 'library.db'), dbKey: randomBytes(32) });
  run(db, `INSERT OR IGNORE INTO keys (id, wrapped_key, created_at) VALUES (1, 'test', '2026-07-13T00:00:00.000Z')`);
  const repo = new PhotosRepository(db);
  const store = new BlobStore({ dataDir });
  await store.init();
  const key: EnvelopeKey = { id: 1, key: randomBytes(32) };
  const originals = new Map<string, Buffer>();
  for (const [index, { id, sample }] of spec.entries()) {
    const bytes = sampleJpeg(sample);
    const ref = await store.putOriginal(Readable.from([bytes]), key, id);
    originals.set(id, bytes);
    repo.insert({
      id,
      fileName: `${id}.JPG`,
      fileKind: 'jpeg',
      width: 1,
      height: 1,
      bytes: ref.bytes,
      contentHash: ref.contentHash,
      camera: null,
      lens: null,
      iso: null,
      aperture: null,
      shutter: null,
      focalLength: null,
      takenAt: null,
      gpsLat: null,
      gpsLon: null,
      place: null,
      importedAt: `2026-07-13T00:0${String(index % 10)}:00.000Z`,
      importSource: 'test',
      keyId: 1,
    } satisfies PhotoInsert);
  }
  const rootDir = mkdtempSync(join(tmpdir(), 'overlook-remote-'));
  const provider = new FlakyProvider({ rootDir });
  const ledger = new SyncLedger(db);
  const coverageRepo = new CoverageRepository(db);
  const audits: string[] = [];
  const syncUpdates: { id: string; syncState: SyncStatus }[][] = [];
  const libraryChanges: string[][] = [];
  let storageChanges = 0;
  let manifestsOwed = 0;
  const excludingWhenOwed: number[] = [];
  let connected = true;
  let restoreOutcome: 'restored' | 'failed' = 'restored';
  const engineDeps: BackupEngineDeps = {
    provider,
    ledger,
    dirtyPhotos: () => repo.dirtyPhotos(),
    encryptedStream: (hash) => store.getEncryptedStream(hash),
    sealManifest: (json) => Promise.resolve(Buffer.from(json)),
    sealRecoveryBootstrap: () => Buffer.from('recovery-bootstrap'),
    libraryId: () => '01JZZZZZZZZZZZZZZZZZZZZZZZ',
    manifestSnapshot: () => repo.manifestSnapshot(),
    settings: () => ({ throttlePercent: null, wifiOnly: false, autoBackupOnImport: false }),
    network: () => 'wifi',
    events: { progress: () => undefined },
    now: () => Date.parse('2026-09-02T03:00:00.000Z'),
    sleep: () => Promise.resolve(),
    pendingCountChanged: () => undefined,
    pendingCount: () => repo.pendingCount(),
    syncStateChanged: () => undefined,
    audit: (line) => audits.push(line),
    integrityScrub: () => Promise.resolve({ checked: 0, repaired: 0, unrecoverable: 0, cycleComplete: true }),
    recoveryGenerationHealthy: () => Promise.resolve(true),
    settleExclusions: () => service.settlePending(),
  };
  const engine = new BackupEngine(engineDeps);
  const service: CoverageService = new CoverageService({
    ledger,
    repo: {
      rows: (ids) => coverageRepo.rows(ids),
      excluding: () => coverageRepo.excluding(),
      includedReferences: (hash) => coverageRepo.includedReferences(hash),
      sidecarHashesForPhoto: () => [],
    },
    // The custody download stands in for OffloadService.restoreOriginals:
    // success puts the original back and promotes the row, failure leaves
    // the row exactly as it was.
    restoreOriginals: async (ids) => {
      const results = [];
      for (const photoId of ids) {
        if (restoreOutcome === 'restored') {
          await store.putOriginal(Readable.from([originals.get(photoId) ?? Buffer.alloc(0)]), key, photoId);
          ledger.setStatus(photoId, 'synced');
        }
        results.push({ photoId, outcome: restoreOutcome });
      }
      return { results };
    },
    hasLocalOriginal: (hash) => store.hasOriginal(hash),
    remoteProvider: () => Promise.resolve(provider),
    providerConnected: () => connected,
    providerIdentity: () =>
      Promise.resolve(connected ? { provider: 'Local mock', account: 'Mock account' } : { provider: null, account: null }),
    oweManifest: () => {
      manifestsOwed += 1;
      excludingWhenOwed.push(coverageRepo.excluding().length);
      engine.oweManifest();
    },
    runBackup: () => engine.run(),
    syncStateChanged: (updates) => syncUpdates.push([...updates]),
    libraryChanged: (ids) => libraryChanges.push([...ids]),
    storageChanged: () => (storageChanges += 1),
    audit: (line) => audits.push(line),
    now: () => '2026-09-02T04:00:00.000Z',
    sleep: () => Promise.resolve(),
  });
  return {
    db,
    repo,
    store,
    ledger,
    provider,
    rootDir,
    engine,
    service,
    duplicate: (sourceId: string, id: string): void => {
      const source = repo.get(sourceId);
      assert.ok(source);
      new VariantRepository(db).duplicate(source, id, '2026-09-02T02:00:00.000Z');
    },
    audits,
    excludingWhenOwed,
    syncUpdates,
    libraryChanges,
    storageChanges: () => storageChanges,
    manifestsOwed: () => manifestsOwed,
    setConnected: (value: boolean) => (connected = value),
    setRestoreOutcome: (value: 'restored' | 'failed') => (restoreOutcome = value),
    hashOf: (id: string) => repo.get(id)?.contentHash ?? '',
  };
}

describe('backup coverage service (#506, ADR-0033)', () => {
  test('preflight tiers: a provider copy makes it irreversible, a local-only row is structural, and skips are named', async () => {
    const w = await world([
      { id: 'P0', sample: 0 },
      { id: 'P1', sample: 1 },
    ]);
    await w.engine.run();
    w.ledger.markDirty('P1');
    w.ledger.setStatus('P1', 'syncing');
    const plan = await w.service.preflight(['P0', 'P1', 'GHOST']);
    assert.equal(plan.tier, 'irreversible');
    assert.deepEqual(
      {
        eligible: plan.eligible,
        ineligible: plan.ineligible,
        remoteCopies: plan.remoteCopies,
        provider: plan.provider,
        account: plan.account,
      },
      { eligible: 1, ineligible: 2, remoteCopies: 1, provider: 'Local mock', account: 'Mock account' },
    );
    assert.equal(plan.remoteBytes, w.repo.get('P0')?.bytes);
    assert.deepEqual(
      plan.items.map((item) => [item.photoId, item.eligible, item.reason]),
      [
        ['P0', true, null],
        ['P1', false, 'in-flight'],
        ['GHOST', false, 'not-found'],
      ],
    );

    const fresh = await world([{ id: 'L0', sample: 2 }]);
    const local = await fresh.service.preflight(['L0']);
    assert.equal(local.tier, 'structural', 'nothing to remove: the row merely stops being backed up');
    assert.equal(local.remoteCopies, 0);

    w.setConnected(false);
    const offline = await w.service.preflight(['P0']);
    assert.deepEqual(offline.items[0]?.reason, 'provider-disconnected', 'a remote copy cannot be removed while disconnected');
    assert.equal(offline.provider, null);
  });

  test('§7: removing a provider copy needs the Remove cloud copy authorization; without it nothing changes', async () => {
    const w = await world([{ id: 'P0', sample: 0 }]);
    await w.engine.run();
    await assert.rejects(w.service.exclude(['P0']), CoverageAuthorizationError);
    await assert.rejects(w.service.exclude(['P0'], 'photos.something-else.v1'), CoverageAuthorizationError);
    assert.equal(w.ledger.coverage('P0')?.coverage, 'included');
    assert.equal(w.ledger.status('P0'), 'synced');
    assert.equal(remoteBlobs(w.rootDir).length, 1);
  });

  test('EXIT CRITERIA: a verified row is recorded as excluding, the manifest lands, then the provider copy goes', async () => {
    const w = await world([
      { id: 'P0', sample: 0 },
      { id: 'P1', sample: 1 },
    ]);
    await w.engine.run();
    assert.equal(remoteBlobs(w.rootDir).length, 2);
    const summary = await w.service.exclude(['P0'], REMOVE_CLOUD_COPY_AUTHORIZATION);
    assert.deepEqual(
      { excluded: summary.excluded, removalPending: summary.removalPending, skipped: summary.skipped, failed: summary.failed },
      { excluded: 1, removalPending: 0, skipped: 0, failed: 0 },
    );
    assert.deepEqual(summary.results, [{ photoId: 'P0', outcome: 'excluded', reason: null }]);
    assert.deepEqual(w.ledger.coverage('P0'), { coverage: 'excluded', origin: 'user', since: '2026-09-02T04:00:00.000Z' });
    assert.equal(w.ledger.status('P0'), 'local', 'no provider copy is claimed');
    assert.equal(w.store.hasOriginal(w.hashOf('P0')), true, 'the local original is untouched');
    assert.equal(remoteBlobs(w.rootDir).length, 1, 'only the sibling remains remote');
    assert.equal(remoteBlobs(w.rootDir).includes(w.hashOf('P1')), true);
    assert.equal(w.manifestsOwed(), 1);
    assert.deepEqual(w.excludingWhenOwed, [0], 'manifest debt is durable before any row is marked excluding');
    assert.equal(w.repo.pendingCount(), 0, 'an excluded row is not backup work');
    assert.equal(w.repo.stats().excludedCount, 1);
    // §2 order is visible in the audit trail: excluding was recorded before
    // the delete, and the delete is audited as the exclusion completing.
    const excluding = w.audits.findIndex((line) => line.startsWith('COVERAGE-EXCLUDING photo=P0'));
    const excluded = w.audits.findIndex((line) => line.startsWith('COVERAGE-EXCLUDED photo=P0'));
    assert.ok(excluding >= 0 && excluded > excluding);
    assert.deepEqual(w.provider.deletes, [`blobs/${w.hashOf('P0').slice(0, 2)}/${w.hashOf('P0')}`]);
    assert.deepEqual(w.syncUpdates.at(-1), [{ id: 'P0', syncState: 'local' }], 'tiles get their targeted push');
    assert.deepEqual(w.libraryChanges.at(-1), ['P0']);
    assert.ok(w.storageChanges() >= 1);
    // A later run does not re-upload it.
    await w.engine.run();
    assert.equal(remoteBlobs(w.rootDir).length, 1);
  });

  test('a local-only row is excluded on the spot without touching the provider (Tier M)', async () => {
    const w = await world([{ id: 'L0', sample: 3 }]);
    const summary = await w.service.exclude(['L0']);
    assert.deepEqual(summary.results, [{ photoId: 'L0', outcome: 'excluded', reason: null }]);
    assert.equal(w.ledger.coverage('L0')?.coverage, 'excluded');
    assert.deepEqual(w.provider.deletes, []);
    assert.equal(w.repo.pendingCount(), 0);
    // The manifest is still owed a generation because the record changed shape.
    assert.equal(w.manifestsOwed(), 1);
  });

  test('§3: the remote object stays while an included sibling shares the asset', async () => {
    const w = await world([{ id: 'P0', sample: 5 }]);
    w.duplicate('P0', 'P1');
    assert.equal(w.hashOf('P0'), w.hashOf('P1'));
    await w.engine.run();
    const plan = await w.service.preflight(['P1']);
    assert.equal(plan.tier, 'structural', 'nothing is removed, so no Tier D authorization is needed');
    assert.equal(plan.sharedRetained, 1);
    const summary = await w.service.exclude(['P1']);
    assert.deepEqual(summary.results, [{ photoId: 'P1', outcome: 'excluded', reason: null }]);
    assert.equal(remoteBlobs(w.rootDir).length, 1, 'the shared object is retained for P0');
    assert.deepEqual(w.provider.deletes, []);
    assert.ok(w.audits.some((line) => line.startsWith('COVERAGE-SHARED-RETAINED photo=P1')));
    assert.equal(w.ledger.coverage('P1')?.coverage, 'excluded');
    assert.equal(w.ledger.status('P0'), 'synced', 'the sibling keeps its verified claim');
  });

  test('§6: a failed delete leaves the row excluding ("removal pending") with an ORPHAN-REMOTE audit, and a later run settles it', async () => {
    const w = await world([{ id: 'P0', sample: 0 }]);
    await w.engine.run();
    w.provider.failDeletes = true;
    const summary = await w.service.exclude(['P0'], REMOVE_CLOUD_COPY_AUTHORIZATION);
    assert.deepEqual(summary.results, [{ photoId: 'P0', outcome: 'removal-pending', reason: null }]);
    assert.equal(summary.removalPending, 1);
    assert.equal(w.ledger.coverage('P0')?.coverage, 'excluding');
    assert.equal(w.ledger.status('P0'), 'synced', 'the provider still holds the copy, and the ledger says so');
    assert.equal(w.provider.deletes.length, 3, 'three attempts with backoff before giving up');
    assert.ok(w.audits.some((line) => line.startsWith('ORPHAN-REMOTE') && line.includes('P0')));
    assert.equal(remoteBlobs(w.rootDir).length, 1);
    assert.equal(w.repo.stats().pendingRemovals, 1);
    assert.equal(w.repo.pendingCount(), 0, 'an excluding row is never re-uploaded');
    const inFlight = await w.service.include(['P0']);
    assert.deepEqual(inFlight.results, [{ photoId: 'P0', outcome: 'skipped', reason: 'in-flight' }]);

    w.provider.failDeletes = false;
    await w.engine.run();
    assert.equal(w.ledger.coverage('P0')?.coverage, 'excluded');
    assert.equal(w.ledger.status('P0'), 'local');
    assert.equal(remoteBlobs(w.rootDir).length, 0);
    assert.equal(w.repo.stats().pendingRemovals, 0);
  });

  test('§2: a cloud-only original is downloaded first; when that fails the row is left exactly as it was', async () => {
    const w = await world([{ id: 'P0', sample: 0 }]);
    await w.engine.run();
    await w.store.deleteOriginal(w.hashOf('P0'));
    w.ledger.repairStatus('P0', 'offloaded');
    const plan = await w.service.preflight(['P0']);
    assert.equal(plan.downloads, 1);

    w.setRestoreOutcome('failed');
    const failed = await w.service.exclude(['P0'], REMOVE_CLOUD_COPY_AUTHORIZATION);
    assert.deepEqual(failed.results, [{ photoId: 'P0', outcome: 'failed', reason: 'restore-failed' }]);
    assert.equal(w.ledger.coverage('P0')?.coverage, 'included');
    assert.equal(w.ledger.status('P0'), 'offloaded');
    assert.equal(remoteBlobs(w.rootDir).length, 1, 'the only copy is never deleted');

    w.setRestoreOutcome('restored');
    const ok = await w.service.exclude(['P0'], REMOVE_CLOUD_COPY_AUTHORIZATION);
    assert.deepEqual(ok.results, [{ photoId: 'P0', outcome: 'excluded', reason: null }]);
    assert.equal(w.store.hasOriginal(w.hashOf('P0')), true, 'local custody was proven before the provider copy went');
    assert.equal(remoteBlobs(w.rootDir).length, 0);
  });

  test('known local-custody failures refuse re-inclusion and never upload the failed original (#1135)', async () => {
    const w = await world([{ id: 'P0', sample: 0 }]);
    await w.engine.run();
    await w.service.exclude(['P0'], REMOVE_CLOUD_COPY_AUTHORIZATION);
    for (const failure of ['local-missing', 'local-corrupt']) {
      run(w.db, 'UPDATE photos SET local_custody_failure = ? WHERE id = ?', failure, 'P0');
      const before = w.ledger.coverage('P0');
      const result = await w.service.include(['P0']);
      assert.deepEqual(result.results, [{ photoId: 'P0', outcome: 'failed', reason: failure }]);
      assert.deepEqual(w.ledger.coverage('P0'), before);
      assert.equal(w.ledger.isDirty('P0'), false);
      assert.equal(w.ledger.status('P0'), 'local');
      assert.equal(w.ledger.requiresRemoteCustody('P0'), false, 'a failed local original must never borrow remote custody');
      await w.engine.run();
      assert.equal(remoteBlobs(w.rootDir).length, 0);
    }
  });

  test('§5: Back up again is an ordinary dirty row that the next run uploads and verifies; it fails closed without a local original', async () => {
    const w = await world([
      { id: 'P0', sample: 0 },
      { id: 'P1', sample: 1 },
    ]);
    await w.engine.run();
    await w.service.exclude(['P0', 'P1'], REMOVE_CLOUD_COPY_AUTHORIZATION);
    assert.equal(remoteBlobs(w.rootDir).length, 0);
    await w.store.deleteOriginal(w.hashOf('P1'));

    const summary = await w.service.include(['P0', 'P1', 'GHOST']);
    assert.deepEqual(summary.results, [
      { photoId: 'P0', outcome: 'included', reason: null },
      { photoId: 'P1', outcome: 'failed', reason: 'local-missing' },
      { photoId: 'GHOST', outcome: 'skipped', reason: 'not-found' },
    ]);
    assert.equal(w.ledger.coverage('P0')?.coverage, 'included');
    assert.equal(w.ledger.isDirty('P0'), true);
    assert.deepEqual(w.ledger.coverage('P1')?.coverage, 'included');
    assert.equal(w.ledger.status('P1'), 'error', 'fail closed: included but visibly not backed up');
    assert.ok(w.audits.some((line) => line.startsWith('COVERAGE-INCLUDE-FAILED photo=P1')));

    await w.engine.run();
    assert.equal(w.ledger.status('P0'), 'synced');
    assert.equal(remoteBlobs(w.rootDir).includes(w.hashOf('P0')), true, 'the verified upload put the copy back');
    const again = await w.service.include(['P0']);
    assert.deepEqual(again.results, [{ photoId: 'P0', outcome: 'skipped', reason: 'already-included' }]);
  });
});
