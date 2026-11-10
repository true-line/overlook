import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { BlobStore } from '../../src/main/blobs/blob-store.js';
import type { KeyStore } from '../../src/main/crypto/keystore.js';
import { openLibraryDatabase } from '../../src/main/db/database.js';
import type { ImportRuntime } from '../../src/main/import/import-runtime.js';
import { buildMaintenanceServices } from '../../src/main/import/maintenance-runtime.js';
import type { DuplicateIndexService } from '../../src/main/library/duplicate-index-service.js';
import type { HistogramService } from '../../src/main/library/histogram-service.js';
import type { ProtectedRuntime } from '../../src/main/library/protected-runtime.js';

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
  const key = { id: 1, key: randomBytes(32) };
  const keyStore = {
    currentKey: () => key,
    resolver: () => () => key.key,
  } as unknown as KeyStore;
  const blobStore = {} as unknown as BlobStore;
  const blobStoreReady = Promise.resolve();

  const histGate = deferred();
  const dupGate = deferred();
  let histClosed = false;
  let dupClosed = false;
  let unfollowed = false;

  const services = buildMaintenanceServices({
    parts: {
      db,
      blobStore,
      blobStoreReady,
      keyStore,
      protected: {} as ProtectedRuntime,
    },
    runtime: { thumbnails: {} } as unknown as ImportRuntime,
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
      service: { invalidate: () => undefined } as unknown as HistogramService,
      close: async () => {
        await histGate.promise;
        histClosed = true;
      },
    }),
    createDuplicates: () => ({
      service: {
        schedule: () => undefined,
        notifyLibraryChanged: () => undefined,
        notifyEligibilityChanged: () => undefined,
      } as unknown as DuplicateIndexService,
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
    db.close();
  }
});
