import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { activityBackupSnapshot, createActivityFacade, mutateWithActivity } from '../../src/main/activity/activity-publication.js';
import { ActivityRepository } from '../../src/main/activity/activity-repository.js';
import { openLibraryDatabase } from '../../src/main/db/database.js';

function world(policy = { maxEvents: 100, maxAgeMs: 1_000_000, maxPayloadBytes: 10_000 }) {
  const db = openLibraryDatabase({
    path: join(mkdtempSync(join(tmpdir(), 'overlook-activity-')), 'library.db'),
    dbKey: randomBytes(32),
  });
  return { db, repo: new ActivityRepository(db, policy) };
}

function append(repo: ActivityRepository, id: string, occurredAt = '2026-07-20T00:00:00.000Z') {
  return repo.append({
    eventId: `event-${id}`,
    operationId: `operation-${id}`,
    eventType: 'photo.favorite-changed',
    occurredAt,
    entityIds: [`photo-${id}`],
    outcome: 'succeeded',
    payload: { favorite: true },
  });
}

describe('ActivityRepository (#614, ADR-0025)', () => {
  test('facade publishes trusted mutations, notifies readers, and snapshots activity', () => {
    const { db } = world();
    let changes = 0;
    const activity = createActivityFacade(db, () => {
      changes += 1;
    });

    activity.record({ eventType: 'import.completed', outcome: 'succeeded', payload: { imported: 2 } });
    assert.equal(
      mutateWithActivity(
        () => activity,
        () => 3,
        (favoriteCount) => ({
          eventType: 'photo.favorite-changed',
          outcome: 'succeeded',
          payload: { favorite: favoriteCount > 0 },
        }),
      ),
      3,
    );
    assert.equal(
      mutateWithActivity(
        undefined,
        () => 'unchanged',
        () => undefined,
      ),
      'unchanged',
    );
    assert.equal(changes, 2);
    assert.deepEqual(
      activity.page(10).events.map((event) => event.eventType),
      ['photo.favorite-changed', 'import.completed'],
    );
    assert.equal(activityBackupSnapshot(db).length, 2);
    db.close();
  });

  test('orders and cursor-pages append-only events across restart', () => {
    const { db, repo } = world();
    append(repo, 'a');
    append(repo, 'b');
    append(repo, 'c');
    const first = repo.page(2);
    assert.deepEqual(
      first.events.map((event) => event.eventId),
      ['event-c', 'event-b'],
    );
    assert.notEqual(first.nextCursor, null);
    const reopened = new ActivityRepository(db);
    assert.deepEqual(
      reopened.page(2, first.nextCursor ?? undefined).events.map((event) => event.eventId),
      ['event-a'],
    );
    db.close();
  });

  test('returns exact retries and rejects operation identity reuse with changed content', () => {
    const { db, repo } = world();
    const event = append(repo, 'same');
    assert.equal(append(repo, 'same').sequence, event.sequence);
    assert.throws(
      () =>
        repo.append({
          eventId: 'event-different',
          operationId: 'operation-same',
          eventType: 'photo.favorite-changed',
          occurredAt: '2026-07-20T00:00:00.000Z',
          entityIds: ['photo-same'],
          outcome: 'succeeded',
          payload: { favorite: false },
        }),
      /reused with different content/,
    );
    db.close();
  });

  test('rolls back a local mutation when its activity append fails', () => {
    const { db, repo } = world();
    db.exec('CREATE TABLE mutation_probe (id TEXT PRIMARY KEY)');
    assert.throws(
      () =>
        repo.transaction(() => {
          db.prepare('INSERT INTO mutation_probe (id) VALUES (?)').run('changed');
          repo.append({
            eventId: 'event-failed',
            operationId: 'operation-failed',
            eventType: 'album.renamed',
            occurredAt: '2026-07-20T00:00:00.000Z',
            outcome: 'succeeded',
            payload: { albumName: 'private' },
          });
        }),
      /sensitive field/,
    );
    const probe = db.prepare('SELECT COUNT(*) AS count FROM mutation_probe').get() as { count: number };
    assert.equal(probe.count, 0);
    db.close();
  });

  test('defers a failed cross-boundary publication and retries it after restart', () => {
    const { db, repo } = world();
    const originalAppend = repo.append.bind(repo);
    let failOnce = true;
    repo.append = (event) => {
      if (failOnce) {
        failOnce = false;
        throw new Error('injected publication failure');
      }
      return originalAppend(event);
    };
    const event = {
      eventId: 'event-deferred',
      operationId: 'operation-deferred',
      eventType: 'import.completed' as const,
      occurredAt: '2026-07-20T00:00:00.000Z',
      outcome: 'succeeded' as const,
      payload: { imported: 2 },
    };
    assert.equal(repo.publishAfterBoundary(event), 'pending');
    assert.equal(repo.page(10).events.length, 0);
    const reopened = new ActivityRepository(db);
    assert.equal(reopened.flushPending(), 1);
    assert.equal(reopened.page(10).events[0]?.eventId, event.eventId);
    db.close();
  });

  test('prunes by age/count/bytes without removing an active retention hold', () => {
    const { db, repo } = world({ maxEvents: 2, maxAgeMs: 1_000, maxPayloadBytes: 40 });
    const held = append(repo, 'held', '2026-07-20T00:00:00.000Z');
    repo.hold(held.eventId, 'undo-held', '2026-07-20T01:00:00.000Z');
    append(repo, 'middle', '2026-07-20T00:00:01.000Z');
    append(repo, 'new', '2026-07-20T00:00:02.000Z');
    assert.equal(repo.prune(new Date('2026-07-20T00:00:02.500Z')), 1);
    assert.deepEqual(
      repo.page(10).events.map((event) => event.eventId),
      ['event-new', 'event-held'],
    );
    repo.releaseHold(held.eventId, 'undo-held');
    assert.equal(repo.prune(new Date('2026-07-20T00:00:03.000Z')), 1);
    db.close();
  });

  test('payload-budget pruning preserves the newest activity', () => {
    const { db, repo } = world({ maxEvents: 100, maxAgeMs: 1_000_000, maxPayloadBytes: 20 });
    append(repo, 'oldest');
    append(repo, 'middle');
    append(repo, 'newest');
    assert.equal(repo.prune(new Date('2026-07-20T00:00:01.000Z')), 2);
    assert.deepEqual(
      repo.page(10).events.map((event) => event.eventId),
      ['event-newest'],
    );
    db.close();
  });

  test('rejects sensitive path-shaped payloads and restores an ordered backup snapshot', () => {
    const source = world();
    append(source.repo, 'a');
    append(source.repo, 'b');
    assert.throws(
      () =>
        source.repo.append({
          eventId: 'event-path',
          operationId: 'operation-path',
          eventType: 'import.completed',
          occurredAt: '2026-07-20T00:00:00.000Z',
          outcome: 'succeeded',
          payload: { sourcePath: '/Users/alice/Secret Photos' },
        }),
      /sensitive field/,
    );
    assert.throws(
      () =>
        source.repo.append({
          eventId: 'event-nested-key',
          operationId: 'operation-nested-key',
          eventType: 'import.completed',
          occurredAt: '2026-07-20T00:00:00.000Z',
          outcome: 'succeeded',
          payload: { details: { fileName: 'secret.jpg' } } as unknown as Record<string, string>,
        }),
      /sensitive field: fileName/,
    );
    assert.throws(
      () =>
        source.repo.append({
          eventId: 'event-nested-array',
          operationId: 'operation-nested-array',
          eventType: 'import.completed',
          occurredAt: '2026-07-20T00:00:00.000Z',
          outcome: 'succeeded',
          payload: { items: ['C:\\Users\\alice\\secret.jpg'] } as unknown as Record<string, string>,
        }),
      /external path/,
    );
    const target = world();
    target.repo.restoreSnapshot(source.repo.backupSnapshot());
    assert.deepEqual(
      target.repo.page(10).events.map((event) => event.eventId),
      ['event-b', 'event-a'],
    );
    assert.throws(() => target.repo.restoreSnapshot([...source.repo.backupSnapshot()].reverse()), /sequence must increase/);
    source.db.close();
    target.db.close();
  });

  test('isolates activity in each encrypted library database', () => {
    const libraryA = world();
    const libraryB = world();
    append(libraryA.repo, 'a');
    append(libraryB.repo, 'b');
    assert.deepEqual(
      libraryA.repo.page(10).events.map((event) => event.eventId),
      ['event-a'],
    );
    assert.deepEqual(
      libraryB.repo.page(10).events.map((event) => event.eventId),
      ['event-b'],
    );
    libraryA.db.close();
    libraryB.db.close();
  });
});
