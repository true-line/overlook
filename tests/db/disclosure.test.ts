import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createActivityFacade } from '../../src/main/activity/activity-publication.js';
import { openLibraryDatabase } from '../../src/main/db/database.js';
import { MIGRATIONS } from '../../src/main/db/migrations.js';
import { PhotosRepository } from '../../src/main/db/photos-repository.js';
import { queryGet, run } from '../../src/main/db/sql.js';
import { DisclosureRepository } from '../../src/main/disclosure/disclosure-repository.js';
import { DisclosureService } from '../../src/main/disclosure/disclosure-service.js';
import { DEFAULT_DISCLOSURE_FIELDS, DEFAULT_DISCLOSURE_POLICY } from '../../src/shared/disclosure/policy.js';
import type { PhotoInsert } from '../../src/shared/library/types.js';

// #509 / ADR-0032 §6 over the real database: migration 37 seeds the §6
// defaults, the repository never widens on a row it cannot parse, and the
// service records policy changes by field name and class only.

const AT = '2026-09-02T00:00:00.000Z';

function photo(id: string, overrides: Partial<PhotoInsert> = {}): PhotoInsert {
  return {
    id,
    fileName: `${id}.JPG`,
    fileKind: 'jpeg',
    width: 30,
    height: 20,
    bytes: 10,
    contentHash: id.repeat(8).slice(0, 64).padEnd(64, '0'),
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
    importedAt: AT,
    importSource: 'camera',
    favorite: false,
    keyId: 1,
    ...overrides,
  };
}

function open() {
  const db = openLibraryDatabase({
    path: join(mkdtempSync(join(tmpdir(), 'overlook-disclosure-db-')), 'library.db'),
    dbKey: randomBytes(32),
  });
  run(db, `INSERT INTO keys (id, wrapped_key, created_at) VALUES (1, 'test', ?)`, AT);
  const photos = new PhotosRepository(db);
  photos.insert(photo('P1', { camera: 'Leica M11' }));
  photos.insert(photo('P2', { takenAt: '2026-07-13T10:00:00.000Z', gpsLat: 52.37, gpsLon: 4.9 }));
  run(db, `INSERT INTO albums (id, name, created_at, position) VALUES ('A1', 'Travel', ?, 0)`, AT);
  run(db, `INSERT INTO album_photos (album_id, photo_id, position) VALUES ('A1', 'P1', 0)`);
  const audit: string[] = [];
  let changed = 0;
  const activity = createActivityFacade(db, () => undefined);
  const service = new DisclosureService({
    db,
    getPhoto: (id) => photos.get(id),
    exportableIds: () => ['P1', 'P2'],
    sidecarCount: (id) => (id === 'P2' ? 1 : 0),
    activity: () => activity,
    audit: (line) => audit.push(line),
    changed: () => {
      changed += 1;
    },
    now: () => new Date(AT),
  });
  return { db, photos, repo: new DisclosureRepository(db), service, audit, activity, changed: () => changed };
}

describe('disclosure policy storage (#509, migration 37)', () => {
  test('migration 37 remains registered and seeds the §6 defaults; an unparseable row falls back to them instead of widening', () => {
    assert.deepEqual(
      MIGRATIONS.filter((migration) => migration.version === 37).map((migration) => ({ version: migration.version, name: migration.name })),
      [{ version: 37, name: 'disclosure-policy' }],
    );
    const { db, repo } = open();
    const row = queryGet<{ version: number; fields: string }>(db, 'SELECT version, fields FROM disclosure_policy WHERE id = 1');
    assert.ok(row);
    assert.equal(row.version, 1);
    assert.deepEqual(JSON.parse(row.fields), DEFAULT_DISCLOSURE_FIELDS);
    assert.deepEqual(repo.policy(), DEFAULT_DISCLOSURE_POLICY);

    const stored = repo.writePolicy(
      { ...DEFAULT_DISCLOSURE_POLICY, fields: { ...DEFAULT_DISCLOSURE_FIELDS, title: 'private' } },
      () => new Date(AT),
    );
    assert.equal(stored.fields.title, 'private');
    assert.equal(repo.policy().fields.title, 'private');

    run(db, `UPDATE disclosure_policy SET fields = '{"title":"public","custody":"public"}' WHERE id = 1`);
    assert.deepEqual(repo.policy(), DEFAULT_DISCLOSURE_POLICY, 'a row this build cannot parse reads as the defaults, never as public');
    assert.throws(
      () =>
        run(
          db,
          `INSERT INTO disclosure_overrides (scope, scope_id, field, class, widened, updated_at) VALUES ('album', 'A1', 'title', 'shared', 0, ?)`,
          AT,
        ),
      /CHECK/u,
    );
    assert.throws(
      () =>
        run(
          db,
          `INSERT INTO disclosure_overrides (scope, scope_id, field, class, widened, updated_at) VALUES ('photo', 'P1', 'title', 'loud', 0, ?)`,
          AT,
        ),
      /CHECK/u,
    );
  });

  test('overrides are keyed by scope and field, batch-readable, clearable, and a photo knows its collections', () => {
    const { repo } = open();
    repo.setOverride('collection', 'A1', 'title', 'private', false, () => new Date(AT));
    repo.setOverride('collection', 'A2', 'location', 'shared', true, () => new Date(AT));
    repo.setOverride('photo', 'P1', 'location', 'shared', true, () => new Date(AT));
    assert.deepEqual(repo.overrides('collection', 'A1'), [{ field: 'title', class: 'private', widened: false }]);
    assert.deepEqual(
      [...repo.overridesFor('collection', ['A1', 'A2', 'A3']).entries()],
      [
        ['A1', [{ field: 'title', class: 'private', widened: false }]],
        ['A2', [{ field: 'location', class: 'shared', widened: true }]],
      ],
    );
    assert.deepEqual(repo.overridesFor('collection', []).size, 0);
    repo.setOverride('collection', 'A1', 'title', 'shared', false, () => new Date(AT));
    assert.deepEqual(repo.overrides('collection', 'A1'), [{ field: 'title', class: 'shared', widened: false }], 'upsert');
    repo.clearOverride('collection', 'A1', 'title');
    assert.deepEqual(repo.overrides('collection', 'A1'), []);
    assert.deepEqual(repo.collectionsOf('P1'), ['A1']);
    assert.deepEqual(repo.collectionsOf('P2'), []);
  });
});

describe('disclosure service (#509)', () => {
  test('a class change is audited and reaches activity by field name and class only; the same class again is a no-op', () => {
    const { service, audit, activity, changed } = open();
    const stored = service.setField('captureTime', 'private');
    assert.equal(changed(), 1, 'mounted projections are told to re-enumerate (PR #1140 review)');
    assert.equal(stored.fields.captureTime, 'private');
    assert.equal(service.policy().fields.captureTime, 'private');
    assert.deepEqual(audit, ['DISCLOSURE-POLICY scope=library field=captureTime from=shared to=private version=1']);
    service.setField('captureTime', 'private');
    assert.equal(changed(), 1, 'a no-op change invalidates nothing');
    const events = activity.page(10).events.filter((event) => event.eventType === 'disclosure.policy-changed');
    assert.equal(events.length, 1);
    assert.deepEqual(events[0]?.payload, { scope: 'library', field: 'captureTime', from: 'shared', to: 'private', policyVersion: 1 });
    assert.ok(!JSON.stringify(events).includes('2026-07-13'), 'no photo value in the record');
    service.setOverride('photo', 'P2', 'location', 'shared');
    assert.equal(changed(), 2);
    assert.ok(service.pinned().includes('key material and key references'));
  });

  test('scope resolution over the real chain: a collection narrows, a photo widens only by explicit action', () => {
    const { service, activity } = open();
    service.setOverride('collection', 'A1', 'camera', 'private');
    assert.deepEqual(service.plan('P1', 'export').withheld, ['camera', 'location'], 'P1 sits in A1, which narrowed camera');
    assert.deepEqual(service.plan('P2', 'export').withheld, ['location']);

    const overrides = service.setOverride('photo', 'P2', 'location', 'shared');
    assert.deepEqual(overrides, [{ field: 'location', class: 'shared', widened: true }], 'wider than inherited = an explicit widening');
    assert.deepEqual(service.plan('P2', 'export').withheld, []);
    const widenings = activity.page(10).events.filter((event) => event.eventType === 'disclosure.policy-changed');
    assert.deepEqual(
      widenings.map((event) => event.payload),
      [
        { scope: 'photo', field: 'location', from: 'inherit', to: 'shared', widened: true },
        { scope: 'collection', field: 'camera', from: 'inherit', to: 'private', widened: false },
      ],
    );
    service.setOverride('photo', 'P2', 'location', null);
    assert.deepEqual(service.plan('P2', 'export').withheld, ['location'], 'cleared = inherits private again');
    assert.deepEqual(service.plan('P2', 'export', 'public').disclosed, [], 'nothing defaults to public');
  });

  test('the preview tallies what crosses, samples a disclosed value, and names what the original bytes would carry', async () => {
    const { service } = open();
    const preview = await service.preview({ boundary: 'export', destination: 'shared', payload: 'original', metadata: 'original' });
    assert.equal(preview.photos, 2);
    assert.equal(preview.policyVersion, 1);
    const row = (field: string) => preview.fields.find((entry) => entry.field === field);
    assert.deepEqual(row('camera'), {
      field: 'camera',
      class: 'shared',
      disclosed: 1,
      withheld: 0,
      present: 1,
      sample: 'Leica M11',
      widened: false,
    });
    assert.deepEqual(row('location'), {
      field: 'location',
      class: 'private',
      disclosed: 0,
      withheld: 1,
      present: 1,
      sample: null,
      widened: false,
    });
    assert.equal(row('title')?.present, 0);
    const mixed = await service.preview({
      boundary: 'export',
      destination: 'shared',
      payload: 'baked',
      photoIds: ['P2', 'P1'],
      operation: { narrow: [], widen: [] },
    });
    assert.equal(
      mixed.fields.find((entry) => entry.field === 'location')?.sample,
      null,
      'a withheld value is never offered as the sample (PR #1140 review)',
    );
    assert.deepEqual(preview.embedded, ['captureTime', 'camera', 'location']);
    assert.deepEqual(preview.blocked, ['location']);
    assert.equal(preview.retainedSidecars, 1, 'P2 keeps a source sidecar that travels unfiltered with an Original export');

    const widened = await service.preview({
      boundary: 'export',
      destination: 'shared',
      payload: 'original',
      metadata: 'none',
      photoIds: ['P2'],
      operation: { narrow: [], widen: ['location'] },
    });
    assert.deepEqual(widened.blocked, []);
    assert.deepEqual(row('location')?.disclosed, 0);
    assert.equal(widened.fields.find((entry) => entry.field === 'location')?.widened, true);
    assert.equal(widened.retainedSidecars, 0, 'without source sidecars nothing travels unfiltered');

    const baked = await service.preview({ boundary: 'export', destination: 'shared', payload: 'baked' });
    assert.deepEqual([baked.embedded, baked.blocked], [[], []], 'a baked payload carries no embedded metadata');
    const published = await service.preview({ boundary: 'photo-kit', destination: 'public', payload: 'original' });
    assert.equal(published.fields.filter((entry) => entry.disclosed > 0).length, 0);
  });
});
