import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, test, type TestContext } from 'node:test';

import { openLibraryDatabase } from '../../src/main/db/database.js';
import { PhotosRepository } from '../../src/main/db/photos-repository.js';
import { run } from '../../src/main/db/sql.js';
import { createActivityFacade } from '../../src/main/activity/activity-publication.js';
import { DisclosureService } from '../../src/main/disclosure/disclosure-service.js';
import { NativeDragOutService, type NativeDragOutDeps } from '../../src/main/native-drag/native-drag-service.js';
import { nativeDragChannels } from '../../src/shared/ipc/native-drag-channels.js';
import type { DisclosureField } from '../../src/shared/disclosure/policy.js';
import { FakeBridge, photo } from './native-drag-fixture.js';

function world(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'overlook-drag-policy-'));
  const db = openLibraryDatabase({ path: join(directory, 'library.db'), dbKey: randomBytes(32) });
  run(db, "INSERT INTO keys (id, wrapped_key, created_at) VALUES (1, 'test', '2026-09-02T00:00:00Z')");
  const rows = new Map([
    ['P1', { ...photo('P1'), gpsLat: 52.37, gpsLon: 4.9 }],
    ['P2', photo('P2')],
  ]);
  const repo = new PhotosRepository(db);
  for (const row of rows.values()) repo.insert(row);
  const disclosure = new DisclosureService({
    db,
    getPhoto: (id) => rows.get(id),
    exportableIds: () => [...rows.keys()],
    audit: () => undefined,
  });
  const activity = createActivityFacade(db, () => undefined);
  const bridge = new FakeBridge();
  let opens = 0;
  let releases = 0;
  let admitted = true;
  const migrating = new Set<string>();
  let open: NativeDragOutDeps['openOriginal'] = () =>
    Promise.resolve({
      stream: Readable.from(['original bytes']),
      release: () => {
        releases++;
        return Promise.resolve();
      },
    });
  const service = new NativeDragOutService({
    bridge,
    disclosure,
    activity: () => activity,
    getPhoto: (id) => rows.get(id),
    isMigrating: (id) => migrating.has(id),
    openOriginal: (row, signal) => {
      opens++;
      return open(row, signal);
    },
    admit: () => admitted,
  });
  t.after(async () => {
    service.close();
    await service.drain();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const start = (ids = ['P1']) => service.start(Buffer.alloc(8), { photoIds: ids, sourceAlbumId: 'internal-album' });
  const output = join(directory, 'receiver.JPG');
  const materialize = () => {
    const input = bridge.input;
    const item = input?.items[0];
    assert.ok(input && item);
    return input.materialize({ token: item.token, destinationPath: output });
  };
  return {
    rows,
    disclosure,
    activity,
    bridge,
    service,
    start,
    materialize,
    output,
    migrating,
    opens: () => opens,
    releases: () => releases,
    setOpen: (next: typeof open) => {
      open = next;
    },
    lock: () => {
      admitted = false;
      service.cancel();
    },
  };
}

describe('native original disclosure materialization only (#1137; signed session remains gated by #1028)', () => {
  test('private GPS refuses the entire selection before advertising or opening any original', (t) => {
    const f = world(t);
    assert.deepEqual(f.start(['P2', 'P1']), { started: false, reason: 'disclosure-withheld', withheld: ['location'] });
    assert.equal(f.bridge.input, null);
    assert.equal(f.opens(), 0);
    assert.equal(f.activity.page(10).events.length, 0);
  });

  for (const field of ['captureTime', 'camera', 'lens'] as const)
    test(`a withheld embedded ${field} uses the same export policy`, (t) => {
      const f = world(t);
      const row = f.rows.get('P1');
      assert.ok(row);
      f.rows.set('P1', { ...row, gpsLat: null, gpsLon: null, takenAt: '2026-01-01', camera: 'PRIVATE CAMERA', lens: 'PRIVATE LENS' });
      f.disclosure.setField(field, 'private');
      assert.deepEqual(f.start().withheld, [field]);
      assert.equal(f.opens(), 0);
    });

  test('allowed bytes stay lazy and exact; Activity contains field names and approved classes only', async (t) => {
    const f = world(t);
    f.disclosure.setOverride('photo', 'P1', 'location', 'shared');
    const row = f.rows.get('P1');
    assert.ok(row);
    f.rows.set('P1', { ...row, camera: 'PRIVATE CAMERA VALUE' });
    f.disclosure.setField('camera', 'public');
    assert.equal(f.start().started, true);
    assert.equal(f.opens(), 0);
    assert.match(f.bridge.input?.internalPayload ?? '', /internal-album/u);
    await f.materialize();
    assert.equal(readFileSync(f.output, 'utf8'), 'original bytes');
    assert.equal(f.releases(), 1);
    const event = f.activity.page(10).events[0];
    assert.ok(event);
    assert.equal(event.eventType, 'photo.exported');
    assert.deepEqual(event.payload, {
      scope: 'native-drag',
      format: 'original',
      disclosureClass: 'shared',
      disclosureWidened: '',
      disclosureNarrowed: '',
      disclosureShared: 'location',
      disclosurePublic: 'camera',
    });
    const recorded = JSON.stringify(event.payload);
    for (const value of ['52.37', '4.9', 'PRIVATE CAMERA VALUE', row.contentHash, f.output, 'original bytes'])
      assert.ok(!recorded.includes(value));
  });

  test('policy narrowed after advertisement refuses before opening receiver content', async (t) => {
    const f = world(t);
    f.disclosure.setField('location', 'shared');
    assert.equal(f.start().started, true);
    f.disclosure.setField('location', 'private');
    await assert.rejects(f.materialize(), /withheld location/u);
    assert.equal(f.opens(), 0);
    assert.equal(existsSync(f.output), false);
  });

  test('newly discovered original metadata is checked from the current main record', async (t) => {
    const f = world(t);
    assert.equal(f.start(['P2']).started, true);
    const row = f.rows.get('P2');
    assert.ok(row);
    f.rows.set('P2', { ...row, gpsLat: 52.37, gpsLon: 4.9 });
    await assert.rejects(f.materialize(), /withheld location/u);
    assert.equal(f.opens(), 0);
  });

  test('policy narrowed while awaiting offloaded custody releases it without writing', async (t) => {
    const f = world(t);
    const row = f.rows.get('P1');
    assert.ok(row);
    f.rows.set('P1', { ...row, syncState: 'offloaded' });
    f.disclosure.setField('location', 'shared');
    let released = false;
    f.setOpen(() => {
      f.disclosure.setField('location', 'private');
      return Promise.resolve({
        stream: Readable.from(['private GPS']),
        release: () => {
          released = true;
          return Promise.resolve();
        },
      });
    });
    assert.equal(f.start().started, true);
    await assert.rejects(f.materialize(), /withheld location/u);
    assert.equal(released, true);
    assert.equal(existsSync(f.output), false);
    assert.equal(f.activity.page(10).events.length, 0);
  });

  test('policy changes during streaming remove the partial receiver file and release custody', async (t) => {
    const f = world(t);
    f.disclosure.setField('location', 'shared');
    f.setOpen(() =>
      Promise.resolve({
        stream: Readable.from(
          (async function* () {
            yield Buffer.from('first');
            await Promise.resolve();
            f.disclosure.setField('location', 'private');
            yield Buffer.from('GPS');
          })(),
        ),
        release: () => Promise.resolve(),
      }),
    );
    assert.equal(f.start().started, true);
    await assert.rejects(f.materialize(), /withheld location/u);
    assert.equal(existsSync(f.output), false);
    assert.equal(f.activity.page(10).events.length, 0);
  });

  for (const state of ['locked', 'deleted', 'migrating', 'replaced'] as const)
    test(`${state} custody after advertisement cannot materialize a stale photo record`, async (t) => {
      const f = world(t);
      f.disclosure.setField('location', 'shared');
      assert.equal(f.start().started, true);
      const row = f.rows.get('P1');
      assert.ok(row);
      if (state === 'migrating') f.migrating.add('P1');
      else
        f.rows.set('P1', {
          ...row,
          locked: state === 'locked',
          deletedAt: state === 'deleted' ? '2026-01-01' : null,
          contentHash: state === 'replaced' ? 'f'.repeat(64) : row.contentHash,
        });
      await assert.rejects(f.materialize(), /content unavailable/u);
      assert.equal(f.opens(), 0);
    });

  test('no renderer-supplied Baked payload or widening intent is supported by native drag', () => {
    for (const extra of [{ mode: 'baked' }, { operation: { narrow: [], widen: ['location'] satisfies DisclosureField[] } }])
      assert.equal(
        nativeDragChannels.nativeDragStart.request.safeParse({ photoIds: ['P1'], sourceAlbumId: null, ...extra }).success,
        false,
      );
  });
});
