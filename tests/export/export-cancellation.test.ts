import assert from 'node:assert/strict';
import { close, createWriteStream, open, write } from 'node:fs';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { test, type TestContext } from 'node:test';

import { ExportEngine, writeFileCleanly, type ExportEngineDeps } from '../../src/main/export/export-engine.js';
import { createExportRuntime } from '../../src/main/export/export-runtime.js';
import type { TranscodeResult } from '../../src/main/export/transcode.js';
import type { PhotoRecord } from '../../src/shared/library/types.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function promptly<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('cancellation remained blocked on active IO')), 1_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

function photo(id: string): PhotoRecord {
  return {
    id,
    fileName: `${id}.JPG`,
    fileKind: 'jpeg',
    mediaInfo: null,
    width: 1,
    height: 1,
    bytes: 8,
    contentHash: 'a'.repeat(64),
    derivativeKey: 'a'.repeat(64),
    variantSourceId: null,
    assetOwnerId: null,
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
    importedAt: '2026-11-28T00:00:00Z',
    importSource: 'test',
    favorite: false,
    isOriginal: false,
    keyId: 1,
    deletedAt: null,
    previewFailure: null,
    dimensionStatus: 'verified',
    syncState: 'offloaded',
    coverage: 'included',
    locked: false,
    title: null,
    description: null,
    tags: [],
    userTags: [],
    importedKeywords: [],
    suppressedKeywords: [],
    metadataVersion: 1,
  };
}

async function world(t: TestContext) {
  const destination = await mkdtemp(join(tmpdir(), 'overlook-cancel-'));
  t.after(() => rm(destination, { recursive: true, force: true }));
  const rows = ['P0', 'P1', 'P2'].map(photo);
  const progress: number[] = [];
  const diagnostics: unknown[] = [];
  const released: string[] = [];
  const opened: string[] = [];
  const deps: ExportEngineDeps = {
    repo: { get: (id) => rows.find((row) => row.id === id) },
    blobs: { getStream: () => Readable.from([Buffer.from('original')]) },
    resolveKey: () => Buffer.alloc(32),
    openOriginal: (row) => {
      opened.push(row.id);
      return Promise.resolve({
        stream: Readable.from([Buffer.from('original')]),
        release: () => {
          released.push(row.id);
          return Promise.resolve();
        },
      });
    },
    writeFile: writeFileCleanly,
    exists: (path) =>
      access(path).then(
        () => true,
        () => false,
      ),
    freeBytes: () => Promise.resolve(1_000_000),
    joinPath: join,
    transcodeJpeg: () => Promise.resolve({ jpeg: Buffer.from('jpeg'), fromPreview: false }),
    bufferStream: (stream) => buffer(stream),
    events: { progress: (done) => progress.push(done) },
    failure: (_id, error) => diagnostics.push(error),
  };
  return { destination, rows, ids: rows.map((row) => row.id), deps, progress, released, opened, diagnostics };
}

test('cancel a stalled original read: keep completed entries, clean partial bytes and release once', async (t) => {
  const w = await world(t);
  const controller = new AbortController();
  const started = deferred<void>();
  const stalled = new PassThrough();
  stalled.write('prefix');
  let received: AbortSignal | undefined;
  const engine = new ExportEngine({
    ...w.deps,
    openOriginal: async (row, signal) => {
      received = signal;
      if (row.id !== 'P1') return w.deps.openOriginal!(row, signal);
      w.opened.push(row.id);
      started.resolve();
      return {
        stream: stalled,
        release: () => {
          w.released.push(row.id);
          return Promise.resolve();
        },
      };
    },
  });
  const run = engine.exportPhotos(w.ids, w.destination, controller.signal);
  await promptly(started.promise);
  controller.abort();
  try {
    const result = await promptly(run);
    assert.equal(received, controller.signal);
    assert.deepEqual([result.exported, result.failed, result.cancelled], [1, 0, 2]);
    await promptly(engine.drain?.() ?? Promise.resolve());
    assert.deepEqual(await readdir(w.destination), ['P0.JPG']);
    assert.equal((await readFile(join(w.destination, 'P0.JPG'))).toString(), 'original');
    assert.equal(stalled.destroyed, true);
    assert.deepEqual(w.released, ['P0', 'P1']);
    assert.deepEqual(w.opened, ['P0', 'P1']);
    assert.deepEqual(w.progress, [1]);
    assert.deepEqual(result.failures, []);
  } finally {
    stalled.end();
    await run;
  }
});

for (const outcome of ['success', 'failure'] as const) {
  test(`cancel custody acquisition; late ${outcome} never resumes the batch`, async (t) => {
    const w = await world(t);
    const controller = new AbortController();
    const started = deferred<void>();
    const gate = deferred<{ stream: Readable; release: () => Promise<void> }>();
    const late = Readable.from([Buffer.from('late')]);
    let received: AbortSignal | undefined;
    const engine = new ExportEngine({
      ...w.deps,
      openOriginal: (row, signal) => {
        received = signal;
        if (row.id !== 'P1') return w.deps.openOriginal!(row, signal);
        w.opened.push(row.id);
        started.resolve();
        return gate.promise;
      },
    });
    const run = engine.exportPhotos(w.ids, w.destination, controller.signal);
    await promptly(started.promise);
    controller.abort();
    try {
      const result = await promptly(run);
      assert.equal(received, controller.signal);
      const snapshot = JSON.stringify(result);
      assert.deepEqual([result.exported, result.failed, result.cancelled], [1, 0, 2]);
      assert.deepEqual(w.released, ['P0']);
      if (outcome === 'success')
        gate.resolve({
          stream: late,
          release: () => {
            w.released.push('P1');
            return Promise.resolve();
          },
        });
      else gate.reject(new Error('late provider failure'));
      await promptly(engine.drain?.() ?? Promise.resolve());
      assert.equal(JSON.stringify(result), snapshot);
      assert.deepEqual(w.released, outcome === 'success' ? ['P0', 'P1'] : ['P0']);
      if (outcome === 'success') assert.equal(late.destroyed, true);
      assert.deepEqual(await readdir(w.destination), ['P0.JPG']);
      assert.deepEqual(w.opened, ['P0', 'P1']);
    } finally {
      gate.resolve({ stream: late, release: () => Promise.resolve() });
      await run;
    }
  });

  test(`cancel an uninterruptible transform; late ${outcome} cannot write or change the result`, async (t) => {
    const w = await world(t);
    const controller = new AbortController();
    const started = deferred<void>();
    const gate = deferred<TranscodeResult>();
    let transforms = 0;
    let received: AbortSignal | undefined;
    const engine = new ExportEngine({
      ...w.deps,
      transcodeJpeg: (_bytes, _kind, options) => {
        received = options?.signal;
        transforms += 1;
        if (transforms === 1) return Promise.resolve({ jpeg: Buffer.from('first'), fromPreview: false });
        started.resolve();
        return gate.promise;
      },
    });
    const run = engine.exportPhotos(w.ids, w.destination, controller.signal, 'jpeg');
    await promptly(started.promise);
    controller.abort();
    try {
      const result = await promptly(run);
      assert.equal(received, controller.signal);
      const snapshot = JSON.stringify(result);
      assert.deepEqual([result.exported, result.failed, result.cancelled], [1, 0, 2]);
      let retired = false;
      const draining = (engine.drain?.() ?? Promise.resolve()).then(() => {
        retired = true;
      });
      await turn();
      assert.equal(retired, false, 'acknowledgement must not claim native work stopped');
      assert.deepEqual(w.released, ['P0']);
      if (outcome === 'success') gate.resolve({ jpeg: Buffer.from('late'), fromPreview: false });
      else gate.reject(new Error('late native failure'));
      await promptly(draining);
      assert.deepEqual(w.released, ['P0', 'P1']);
      assert.deepEqual(await readdir(w.destination), ['P0.jpg']);
      assert.equal(JSON.stringify(result), snapshot);
      assert.equal(transforms, 2);
      assert.deepEqual(w.progress, [1]);
    } finally {
      gate.resolve({ jpeg: Buffer.from('late'), fromPreview: false });
      await run;
    }
  });

  test(`cancel a stalled OS destination write; late ${outcome} closes before cleanup`, async (t) => {
    const w = await world(t);
    const controller = new AbortController();
    const started = deferred<void>();
    const gate = deferred<void>();
    const heldWrite = new Proxy(write, {
      apply(target, receiver: unknown, args: unknown[]) {
        started.resolve();
        void gate.promise.then(() => {
          if (outcome === 'success') Reflect.apply(target, receiver, args);
          else {
            const callback: unknown = args.at(-1);
            assert.equal(typeof callback, 'function');
            if (typeof callback === 'function') Reflect.apply(callback, undefined, [new Error('late disk failure')]);
          }
        });
        return undefined;
      },
    });
    const engine = new ExportEngine({
      ...w.deps,
      writeFile: (path, plaintext, signal) => {
        assert.equal(signal, controller.signal);
        return writeFileCleanly(path, plaintext, signal, (target) =>
          target.endsWith('P1.JPG')
            ? createWriteStream(target, { flags: 'wx', fs: { open, close, write: heldWrite } })
            : createWriteStream(target, { flags: 'wx' }),
        );
      },
    });
    const run = engine.exportPhotos(w.ids, w.destination, controller.signal);
    await promptly(started.promise);
    controller.abort();
    try {
      const result = await promptly(run);
      assert.deepEqual([result.exported, result.failed, result.cancelled], [1, 0, 2]);
      assert.deepEqual(w.released, ['P0']);
      gate.resolve();
      await promptly(engine.drain?.() ?? Promise.resolve());
      assert.deepEqual(await readdir(w.destination), ['P0.JPG']);
      await turn();
      assert.deepEqual(await readdir(w.destination), ['P0.JPG'], 'late IO cannot recreate cleaned output');
      assert.deepEqual(w.released, ['P0', 'P1']);
    } finally {
      gate.resolve();
      await run;
    }
  });
}

test('an open syscall that completes after abort cannot leave a newly created output', async (t) => {
  const w = await world(t);
  const controller = new AbortController();
  const started = deferred<void>();
  const gate = deferred<void>();
  const heldOpen = new Proxy(open, {
    apply(target, receiver: unknown, args: unknown[]) {
      started.resolve();
      void gate.promise.then(() => {
        Reflect.apply(target, receiver, args);
      });
      return undefined;
    },
  });
  const engine = new ExportEngine({
    ...w.deps,
    writeFile: (path, plaintext, signal) =>
      writeFileCleanly(path, plaintext, signal, (target) =>
        createWriteStream(target, { flags: 'wx', fs: { open: heldOpen, close, write } }),
      ),
  });
  const run = engine.exportPhotos(w.ids, w.destination, controller.signal);
  await promptly(started.promise);
  controller.abort();
  try {
    const result = await promptly(run);
    assert.deepEqual([result.exported, result.failed, result.cancelled], [0, 0, 3]);
    gate.resolve();
    await promptly(engine.drain?.() ?? Promise.resolve());
    assert.deepEqual(await readdir(w.destination), []);
    assert.deepEqual(w.released, ['P0']);
  } finally {
    gate.resolve();
    await run;
  }
});

test('write cleanup preserves a pre-existing collision winner', async (t) => {
  const w = await world(t);
  const target = join(w.destination, 'winner');
  await writeFile(target, 'completed');
  await assert.rejects(writeFileCleanly(target, Readable.from(['replacement'])), { code: 'EEXIST' });
  assert.equal((await readFile(target)).toString(), 'completed');
});

test('late failure and a closed diagnostic sink cannot skip or repeat custody release', async (t) => {
  const w = await world(t);
  const controller = new AbortController();
  const started = deferred<void>();
  const gate = deferred<TranscodeResult>();
  let releases = 0;
  const engine = new ExportEngine({
    ...w.deps,
    openOriginal: () =>
      Promise.resolve({
        stream: Readable.from(['original']),
        release: () => {
          releases += 1;
          return Promise.reject(new Error('release failed'));
        },
      }),
    transcodeJpeg: () => {
      started.resolve();
      return gate.promise;
    },
    failure: () => {
      throw new Error('diagnostic sink closed');
    },
  });
  const run = engine.exportPhotos(['P0'], w.destination, controller.signal, 'jpeg');
  await promptly(started.promise);
  controller.abort();
  try {
    const result = await promptly(run);
    gate.reject(new Error('late transform failure'));
    await promptly(engine.drain());
    assert.deepEqual([result.exported, result.failed, result.cancelled], [0, 0, 1]);
    assert.equal(releases, 1);
    assert.deepEqual(await readdir(w.destination), []);
  } finally {
    gate.reject(new Error('retired'));
    await run;
  }
});

test('an IO failure which wins the race stays distinct from later batch cancellation', async (t) => {
  const w = await world(t);
  const controller = new AbortController();
  const engine = new ExportEngine({
    ...w.deps,
    writeFile: () => {
      queueMicrotask(() => queueMicrotask(() => controller.abort()));
      return Promise.reject(new Error('disk failure before abort'));
    },
  });
  const result = await engine.exportPhotos(w.ids, w.destination, controller.signal);
  assert.deepEqual([result.exported, result.failed, result.cancelled], [0, 1, 2]);
  assert.equal(result.failures[0]?.reason, 'disk failure before abort');
  await engine.drain();
  assert.deepEqual(w.released, ['P0']);
  assert.deepEqual(w.progress, [1]);
});

test('a buffering seam that ignores abort cannot start a late transform', async (t) => {
  const w = await world(t);
  const controller = new AbortController();
  const started = deferred<void>();
  const gate = deferred<Buffer>();
  let transforms = 0;
  let reads = 0;
  const engine = new ExportEngine({
    ...w.deps,
    bufferStream: (stream, signal) => {
      assert.equal(signal, controller.signal);
      reads += 1;
      if (reads === 1) return buffer(stream);
      started.resolve();
      return gate.promise;
    },
    transcodeJpeg: () => {
      transforms += 1;
      return Promise.resolve({ jpeg: Buffer.from('jpeg'), fromPreview: false });
    },
  });
  const run = engine.exportPhotos(w.ids, w.destination, controller.signal, 'jpeg');
  await promptly(started.promise);
  controller.abort();
  try {
    const result = await promptly(run);
    assert.deepEqual([result.exported, result.failed, result.cancelled], [1, 0, 2]);
    gate.resolve(Buffer.from('late'));
    await promptly(engine.drain());
    assert.equal(transforms, 1);
    assert.deepEqual(await readdir(w.destination), ['P0.jpg']);
    assert.deepEqual(w.released, ['P0', 'P1']);
  } finally {
    gate.resolve(Buffer.from('late'));
    await run;
  }
});

test('cancelling an unfinished companion group retires late output without removing a completed entry', async (t) => {
  const w = await world(t);
  w.rows[1] = { ...photo('P1'), title: 'authored' };
  const controller = new AbortController();
  const started = deferred<void>();
  const gate = deferred<void>();
  const engine = new ExportEngine({
    ...w.deps,
    writeFile: async (path, stream, signal) => {
      assert.equal(signal, controller.signal);
      if (!path.endsWith('.xmp')) return writeFileCleanly(path, stream, signal);
      started.resolve();
      await gate.promise;
      // An uninterruptible writer may publish bytes after caller acknowledgement.
      await writeFile(path, 'late companion');
    },
  });
  const run = engine.exportPhotos(w.ids, w.destination, controller.signal, 'original', 'overlook');
  await promptly(started.promise);
  controller.abort();
  try {
    const result = await promptly(run);
    assert.deepEqual([result.exported, result.failed, result.cancelled], [1, 0, 2]);
    gate.resolve();
    await promptly(engine.drain());
    assert.deepEqual(await readdir(w.destination), ['P0.JPG']);
    assert.deepEqual(w.released, ['P0', 'P1']);
    assert.deepEqual(w.progress, [1]);
  } finally {
    gate.resolve();
    await run;
  }
});

test('cancel a retained-sidecar preflight read without misreporting it as disclosure failure', async (t) => {
  const w = await world(t);
  const controller = new AbortController();
  const started = deferred<void>();
  const stalled = new PassThrough();
  const engine = new ExportEngine({
    ...w.deps,
    sidecarsFor: () => [{ fileName: 'source.xmp', contentHash: 'b'.repeat(64), keyId: 1, bytes: 10 }],
    sidecarStream: (_id, _hash, signal) => {
      assert.equal(signal, controller.signal);
      started.resolve();
      return stalled;
    },
  });
  const run = engine.exportPhotos(w.ids, w.destination, controller.signal);
  await promptly(started.promise);
  controller.abort();
  try {
    const result = await promptly(run);
    assert.deepEqual([result.exported, result.failed, result.cancelled], [0, 0, 3]);
    await promptly(engine.drain?.() ?? Promise.resolve());
    assert.equal(stalled.destroyed, true);
    assert.deepEqual(w.opened, []);
    assert.deepEqual(await readdir(w.destination), []);
  } finally {
    stalled.end();
    await run;
  }
});

test('runtime acknowledges cancellation but queues new work behind actual custody retirement', async (t) => {
  const w = await world(t);
  const started = deferred<void>();
  const gate = deferred<void>();
  let opens = 0;
  let releases = 0;
  const runtime = createExportRuntime({
    repo: { get: w.deps.repo.get, exportableIds: () => w.ids },
    blobs: w.deps.blobs,
    resolveKey: w.deps.resolveKey,
    openOriginal: async (_row, signal) => {
      assert.ok(signal);
      opens += 1;
      started.resolve();
      await gate.promise;
      return {
        stream: Readable.from(['late']),
        release: () => {
          releases += 1;
          return Promise.resolve();
        },
      };
    },
    progress: () => undefined,
    pickDestination: () => Promise.resolve(null),
  });
  const first = runtime.run(['P0'], w.destination);
  await promptly(started.promise);
  runtime.cancel();
  try {
    assert.equal((await promptly(first)).cancelled, 1);
    const second = runtime.run(['P1'], w.destination);
    await turn();
    assert.equal(opens, 1);
    runtime.close();
    gate.resolve();
    await assert.rejects(second, /export service is closed/u);
    await promptly(runtime.drain());
    assert.equal(opens, 1);
    assert.equal(releases, 1);
    assert.deepEqual(await readdir(w.destination), []);
  } finally {
    gate.resolve();
    await first;
  }
});
