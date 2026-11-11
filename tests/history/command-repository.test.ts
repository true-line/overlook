import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { ActivityRepository } from '../../src/main/activity/activity-repository.js';
import { openLibraryDatabase } from '../../src/main/db/database.js';
import { queryGet, run } from '../../src/main/db/sql.js';
import { CommandRepository } from '../../src/main/history/command-repository.js';

function world() {
  const db = openLibraryDatabase({
    path: join(mkdtempSync(join(tmpdir(), 'overlook-history-')), 'library.db'),
    dbKey: randomBytes(32),
  });
  return { db, activity: new ActivityRepository(db), commands: new CommandRepository(db) };
}

function record(state: ReturnType<typeof world>, id: string, createdAt = '2026-07-21T00:00:00.000Z') {
  const event = state.activity.append({
    eventId: `event-${id}`,
    operationId: `operation-${id}`,
    eventType: 'photo.favorite-changed',
    occurredAt: createdAt,
    outcome: 'succeeded',
  });
  return state.commands.append({
    recordId: `record-${id}`,
    activityEventId: event.eventId,
    commandId: 'photo.favorite.toggle',
    classification: 'immediately-reversible',
    inverse: { kind: 'favorite', photoId: `photo-${id}`, before: false, after: true },
    createdAt,
    expiresAt: '2026-08-20T00:00:00.000Z',
  });
}

describe('CommandRepository (#615, ADR-0025)', () => {
  test('persists a library-scoped durable stack and clears redo on a branch', () => {
    const state = world();
    record(state, 'one');
    state.commands.transition('record-one', 'undo');
    assert.equal(state.commands.top('redo')?.recordId, 'record-one');

    record(state, 'two');
    assert.equal(state.commands.top('redo'), undefined);
    assert.equal(state.commands.top('undo')?.recordId, 'record-two');
    assert.equal(new CommandRepository(state.db).top('undo')?.recordId, 'record-two');
    state.db.close();
  });

  test('reports expiry honestly and returns idempotent execution results', () => {
    const state = world();
    record(state, 'expired', '2026-06-01T00:00:00.000Z');
    run(state.db, 'UPDATE command_records SET expires_at = ? WHERE record_id = ?', '2026-06-30T00:00:00.000Z', 'record-expired');
    assert.equal(state.commands.capability('undo', new Date('2026-07-21T00:00:00.000Z')).status, 'expired');

    record(state, 'current');
    const capability = state.commands.capability('undo', new Date('2026-07-21T00:00:00.000Z'));
    const result = { applied: true, direction: 'undo' as const, capability };
    state.commands.rememberExecution('request-one', 'record-current', result, '2026-07-21T00:00:01.000Z');
    assert.deepEqual(state.commands.execution('request-one'), result);
    state.db.close();
  });

  test('bounds byte leases and redacts expired sensitive paths', () => {
    const state = world();
    const event = state.activity.append({
      eventId: 'event-move',
      operationId: 'operation-move',
      eventType: 'import.completed',
      occurredAt: '2026-07-01T00:00:00.000Z',
      outcome: 'succeeded',
    });
    state.commands.append({
      recordId: 'record-move',
      activityEventId: event.eventId,
      commandId: 'library.import',
      classification: 'compensating-only',
      inverse: {
        kind: 'move-compensation',
        photoId: 'photo-one',
        contentHash: 'a'.repeat(64),
        sourcePath: '/Volumes/Card/photo.jpg',
        byteCharge: 10,
        parentIdentity: 'parent-one',
      },
      createdAt: '2026-07-01T00:00:00.000Z',
      expiresAt: '2026-07-31T00:00:00.000Z',
      sensitiveExpiresAt: '2026-07-08T00:00:00.000Z',
      byteCharge: 10,
    });
    const hold = queryGet<{ expires_at: string }>(
      state.db,
      'SELECT expires_at FROM activity_retention_holds WHERE event_id = ? AND hold_id = ?',
      'event-move',
      'record-move',
    );
    assert.equal(hold?.expires_at, '2026-07-08T00:00:00.000Z');
    state.commands.prune(new Date('2026-07-21T00:00:00.000Z'));
    const inverse = state.commands.byId('record-move')?.inverse;
    assert.equal(inverse?.kind, 'move-compensation');
    if (inverse?.kind === 'move-compensation') assert.equal(inverse.sourcePath, '');
    state.db.close();
  });
});
