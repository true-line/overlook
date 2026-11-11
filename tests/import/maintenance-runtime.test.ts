import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { BlobStore } from '../../src/main/blobs/blob-store.js';
import { KeyStore } from '../../src/main/crypto/keystore.js';
import { openLibraryDatabase } from '../../src/main/db/database.js';
import { FingerprintRepository } from '../../src/main/db/fingerprint-repository.js';
import { buildMaintenanceServices } from '../../src/main/import/maintenance-runtime.js';
import { ThumbnailPool } from '../../src/main/import/thumbnail-pool.js';
import { ThumbnailService } from '../../src/main/import/thumbnail-service.js';
import { DuplicateIndexService } from '../../src/main/library/duplicate-index-service.js';
import { HistogramService } from '../../src/main/library/histogram-service.js';
import { ProtectedRuntime } from '../../src/main/library/protected-runtime.js';

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

test('#1438: buildMaintenanceServices.close awaits histogram and duplicate worker shutdown before resolving', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'overlook-maintenance-close-'));
  const db = openLibraryDatabase({ path: join(dir, 'library.db'), dbKey: randomBytes(32) });
  const keyStore = KeyStore.open({
    dataDir: dir,
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (plain) => Buffer.from(plain, 'utf8'),
      decryptString: (cipher) => cipher.toString('utf8'),
    },
  });
  const blobStore = new BlobStore({ dataDir: dir });
  const blobStoreReady = blobStore.init();
  const protectedRuntime = new ProtectedRuntime({
    dataDir: dir,
    db,
    libraryId: '01J00000000000000000000000',
    ordinaryBlobs: blobStore,
    masterKey: () => keyStore.masterKeyBytes(),
    resolveLibraryKey: () => keyStore.resolver(),
    currentLibraryKey: () => keyStore.currentKey(),
    oweManifest: () => undefined,
    revokeOrdinary: () => undefined,
    progress: () => undefined,
    pickDestination: () => Promise.resolve(null),
    failure: () => undefined,
    repairFailure: () => undefined,
    workflowProgress: () => undefined,
    workflowChanged: () => undefined,
    ordinaryChanged: () => undefined,
  });
  const pool = new ThumbnailPool({ workerUrl: new URL(import.meta.url) });
  const thumbnails = new ThumbnailService(pool, blobStore);

  const histGate = deferred();
  const dupGate = deferred();
  let histClosed = false;
  let dupClosed = false;
  let unfollowed = false;

  const histogramService = new HistogramService({
    repo: { get: () => undefined },
    headRevisionId: () => null,
    loadMid: () => Promise.resolve(null),
    compute: () => Promise.reject(new Error('unused')),
  });
  const duplicateService = new DuplicateIndexService({
    repository: new FingerprintRepository(db),
    load: () => Promise.resolve(null),
    fingerprint: () => Promise.resolve([]),
    records: () => [],
  });

  const services = buildMaintenanceServices({
    parts: {
      db,
      blobStore,
      blobStoreReady,
      keyStore,
      protected: protectedRuntime,
    },
    runtime: { thumbnails },
    appVersion: '0.1.0-test',
    invalidateThumb: () => undefined,
    invalidateFull: () => undefined,
    emitChanged: () => undefined,
    emitCreated: () => undefined,
    emitThumbsChanged: () => undefined,
    emitPending: () => undefined,
    scheduleAutoBackup: () => undefined,
    embeddingEligible: () => undefined,
    emitDuplicatesChanged: () => undefined,
    onLibraryChanged: () => () => {
      unfollowed = true;
    },
    createHistogram: () => ({
      service: histogramService,
      close: async () => {
        await histGate.promise;
        histClosed = true;
      },
    }),
    createDuplicates: () => ({
      service: duplicateService,
      close: async () => {
        await dupGate.promise;
        dupClosed = true;
      },
    }),
  });

  try {
    let settled = false;
    const closing = services.close().then(() => {
      settled = true;
    });
    assert.equal(unfollowed, true);
    await Promise.resolve();
    assert.equal(settled, false, 'close() must wait for histogram and duplicate workers');

    histGate.resolve();
    await Promise.resolve();
    assert.equal(histClosed, true);
    assert.equal(settled, false, 'close() must still wait for duplicate index shutdown');

    dupGate.resolve();
    await closing;
    assert.equal(dupClosed, true);
    assert.equal(settled, true);
  } finally {
    await pool.close();
    keyStore.close();
    db.close();
  }
});
