import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

import type { ActivityAppend, ActivityEvent, ActivityEventType, ActivityPage } from '../../shared/activity/types.js';
import { queryAll, queryGet, run, runNamed } from '../db/sql.js';

interface ActivityRow {
  sequence: number;
  event_id: string;
  operation_id: string;
  event_type: string;
  schema_version: number;
  occurred_at: string;
  actor_class: string;
  root_correlation_id: string;
  causation_event_id: string | null;
  entity_ids_json: string;
  outcome: string;
  payload_json: string;
  supersedes_event_id: string | null;
}

interface PendingActivityRow {
  event_json: string;
}

export interface ActivityRetentionPolicy {
  readonly maxEvents: number;
  readonly maxAgeMs: number;
  readonly maxPayloadBytes: number;
}

export const DEFAULT_ACTIVITY_RETENTION: ActivityRetentionPolicy = {
  maxEvents: 100_000,
  maxAgeMs: 365 * 24 * 60 * 60 * 1_000,
  maxPayloadBytes: 64 * 1024 * 1024,
};

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function parseRow(row: ActivityRow): ActivityEvent {
  return {
    sequence: row.sequence,
    eventId: row.event_id,
    operationId: row.operation_id,
    eventType: row.event_type as ActivityEventType,
    schemaVersion: row.schema_version as 1,
    occurredAt: row.occurred_at,
    actorClass: row.actor_class as ActivityEvent['actorClass'],
    rootCorrelationId: row.root_correlation_id,
    causationEventId: row.causation_event_id,
    entityIds: JSON.parse(row.entity_ids_json) as string[],
    outcome: row.outcome as ActivityEvent['outcome'],
    payload: JSON.parse(row.payload_json) as ActivityEvent['payload'],
    supersedesEventId: row.supersedes_event_id,
  };
}

function comparable(event: ActivityAppend): string {
  return stableJson({
    ...event,
    actorClass: event.actorClass ?? 'local-user',
    rootCorrelationId: event.rootCorrelationId ?? event.operationId,
    causationEventId: event.causationEventId ?? null,
    entityIds: event.entityIds ?? [],
    payload: event.payload ?? {},
    supersedesEventId: event.supersedesEventId ?? null,
  });
}

function assertPrivacySafeValue(value: unknown): void {
  if (typeof value === 'string') {
    if (/^(?:\/|[A-Za-z]:\\|\\\\)/u.test(value) || value.includes('/Users/')) {
      throw new Error('activity payload contains an external path');
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value as readonly unknown[]) {
      assertPrivacySafeValue(item);
    }
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value as Readonly<Record<string, unknown>>)) {
      if (/(?:path|file|name|title|destination|source)/iu.test(key)) {
        throw new Error(`activity payload contains sensitive field: ${key}`);
      }
      assertPrivacySafeValue(nested);
    }
  }
}

function assertPrivacySafePayload(payload: ActivityAppend['payload']): void {
  assertPrivacySafeValue(payload ?? {});
}

export class ActivityRepository {
  constructor(
    private readonly db: BetterSqlite3.Database,
    private readonly policy: ActivityRetentionPolicy = DEFAULT_ACTIVITY_RETENTION,
  ) {}

  transaction<T>(operation: () => T): T {
    return this.db.transaction(operation)();
  }

  append(event: ActivityAppend): ActivityEvent {
    assertPrivacySafePayload(event.payload);
    const existing = this.byOperation(event.operationId, event.eventType);
    if (existing !== undefined) {
      const stored: ActivityAppend = {
        eventId: existing.eventId,
        operationId: existing.operationId,
        eventType: existing.eventType,
        occurredAt: existing.occurredAt,
        actorClass: existing.actorClass,
        rootCorrelationId: existing.rootCorrelationId,
        causationEventId: existing.causationEventId,
        entityIds: existing.entityIds,
        outcome: existing.outcome,
        payload: existing.payload,
        supersedesEventId: existing.supersedesEventId,
      };
      if (comparable(stored) !== comparable(event)) throw new Error('activity operation identity reused with different content');
      return existing;
    }

    runNamed(
      this.db,
      `INSERT INTO activity_events (
         event_id, operation_id, event_type, schema_version, occurred_at,
         actor_class, root_correlation_id, causation_event_id, entity_ids_json,
         outcome, payload_json, supersedes_event_id
       ) VALUES (
         @eventId, @operationId, @eventType, 1, @occurredAt,
         @actorClass, @rootCorrelationId, @causationEventId, @entityIdsJson,
         @outcome, @payloadJson, @supersedesEventId
       )`,
      {
        eventId: event.eventId,
        operationId: event.operationId,
        eventType: event.eventType,
        occurredAt: event.occurredAt,
        actorClass: event.actorClass ?? 'local-user',
        rootCorrelationId: event.rootCorrelationId ?? event.operationId,
        causationEventId: event.causationEventId ?? null,
        entityIdsJson: stableJson(event.entityIds ?? []),
        outcome: event.outcome,
        payloadJson: stableJson(event.payload ?? {}),
        supersedesEventId: event.supersedesEventId ?? null,
      },
    );
    const inserted = this.byOperation(event.operationId, event.eventType);
    if (inserted === undefined) throw new Error('activity event insert was not readable');
    return inserted;
  }

  publishAfterBoundary(event: ActivityAppend): 'published' | 'pending' | 'unavailable' {
    try {
      this.append(event);
      return 'published';
    } catch {
      try {
        assertPrivacySafePayload(event.payload);
        runNamed(
          this.db,
          `INSERT OR IGNORE INTO activity_pending_publications (event_id, event_json, created_at)
           VALUES (@eventId, @eventJson, @createdAt)`,
          { eventId: event.eventId, eventJson: stableJson(event), createdAt: event.occurredAt },
        );
        return 'pending';
      } catch {
        return 'unavailable';
      }
    }
  }

  flushPending(): number {
    const rows = queryAll<PendingActivityRow>(
      this.db,
      'SELECT event_json FROM activity_pending_publications ORDER BY created_at, event_id',
    );
    let published = 0;
    for (const row of rows) {
      const event = JSON.parse(row.event_json) as ActivityAppend;
      try {
        this.append(event);
        run(this.db, 'DELETE FROM activity_pending_publications WHERE event_id = ?', event.eventId);
        published += 1;
      } catch {
        break;
      }
    }
    return published;
  }

  page(limit: number, cursor?: number): ActivityPage {
    const rows = queryAll<ActivityRow>(
      this.db,
      `SELECT * FROM activity_events
       ${cursor === undefined ? '' : 'WHERE sequence < @cursor'}
       ORDER BY sequence DESC LIMIT @limit`,
      cursor === undefined ? { limit: limit + 1 } : { cursor, limit: limit + 1 },
    );
    const more = rows.length > limit;
    const visible = rows.slice(0, limit).map(parseRow);
    return { events: visible, nextCursor: more ? (visible.at(-1)?.sequence ?? null) : null };
  }

  backupSnapshot(): readonly ActivityEvent[] {
    this.flushPending();
    return queryAll<ActivityRow>(this.db, 'SELECT * FROM activity_events ORDER BY sequence').map(parseRow);
  }

  restoreSnapshot(events: readonly ActivityEvent[]): void {
    for (const [index, event] of events.entries()) {
      if (index > 0 && event.sequence <= events[index - 1]!.sequence) {
        throw new Error('activity restore sequence must increase');
      }
    }
    const transaction = this.db.transaction(() => {
      for (const event of events) {
        assertPrivacySafePayload(event.payload);
        runNamed(
          this.db,
          `INSERT INTO activity_events (
             sequence, event_id, operation_id, event_type, schema_version, occurred_at,
             actor_class, root_correlation_id, causation_event_id, entity_ids_json,
             outcome, payload_json, supersedes_event_id
           ) VALUES (
             @sequence, @eventId, @operationId, @eventType, 1, @occurredAt,
             @actorClass, @rootCorrelationId, @causationEventId, @entityIdsJson,
             @outcome, @payloadJson, @supersedesEventId
           )`,
          {
            sequence: event.sequence,
            eventId: event.eventId,
            operationId: event.operationId,
            eventType: event.eventType,
            occurredAt: event.occurredAt,
            actorClass: event.actorClass,
            rootCorrelationId: event.rootCorrelationId,
            causationEventId: event.causationEventId,
            entityIdsJson: stableJson(event.entityIds),
            outcome: event.outcome,
            payloadJson: stableJson(event.payload),
            supersedesEventId: event.supersedesEventId,
          },
        );
      }
    });
    transaction();
  }

  hold(eventId: string, holdId: string, expiresAt: string): void {
    run(
      this.db,
      `INSERT INTO activity_retention_holds (event_id, hold_id, expires_at) VALUES (?, ?, ?)
       ON CONFLICT (event_id, hold_id) DO UPDATE SET expires_at = excluded.expires_at`,
      eventId,
      holdId,
      expiresAt,
    );
  }

  releaseHold(eventId: string, holdId: string): void {
    run(this.db, 'DELETE FROM activity_retention_holds WHERE event_id = ? AND hold_id = ?', eventId, holdId);
  }

  prune(now: Date): number {
    run(this.db, 'DELETE FROM activity_retention_holds WHERE expires_at <= ?', now.toISOString());
    const cutoff = new Date(now.getTime() - this.policy.maxAgeMs).toISOString();
    const candidates = queryAll<{ event_id: string; occurred_at: string; payload_bytes: number }>(
      this.db,
      `SELECT e.event_id, e.occurred_at, length(e.payload_json) AS payload_bytes
       FROM activity_events e
       LEFT JOIN activity_retention_holds h ON h.event_id = e.event_id
       WHERE h.event_id IS NULL
       ORDER BY e.sequence DESC`,
    );
    let payloadBytes = candidates.reduce((total, row) => total + row.payload_bytes, 0);
    const remove = new Set<string>();
    for (const [index, row] of candidates.entries()) {
      const overCount = index >= this.policy.maxEvents;
      const overAge = row.occurred_at < cutoff;
      if (overCount || overAge) {
        remove.add(row.event_id);
        payloadBytes -= row.payload_bytes;
      }
    }
    for (const row of [...candidates].reverse()) {
      if (payloadBytes <= this.policy.maxPayloadBytes) break;
      if (remove.has(row.event_id)) continue;
      remove.add(row.event_id);
      payloadBytes -= row.payload_bytes;
    }
    const transaction = this.db.transaction(() => {
      for (const eventId of remove) run(this.db, 'DELETE FROM activity_events WHERE event_id = ?', eventId);
    });
    transaction();
    return remove.size;
  }

  private byOperation(operationId: string, eventType: ActivityEventType): ActivityEvent | undefined {
    const row = queryGet<ActivityRow>(
      this.db,
      'SELECT * FROM activity_events WHERE operation_id = ? AND event_type = ?',
      operationId,
      eventType,
    );
    return row === undefined ? undefined : parseRow(row);
  }
}
