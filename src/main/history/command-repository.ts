import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';
import { statfsSync } from 'node:fs';
import { dirname } from 'node:path';

import type {
  CapabilitySnapshot,
  CommandRecord,
  CommandRecordDraft,
  HistoryExecutionResult,
  InverseParameters,
} from '../../shared/history/types.js';
import type { CommandId } from '../../shared/commands/registry.js';
import { queryAll, queryGet, run, runNamed } from '../db/sql.js';

interface CommandRow {
  sequence: number;
  record_id: string;
  activity_event_id: string;
  command_id: string;
  classification: CommandRecord['classification'];
  inverse_json: string;
  stack: CommandRecord['stack'];
  created_at: string;
  expires_at: string;
  sensitive_expires_at: string | null;
  byte_charge: number;
}

interface ExecutionRow {
  result_json: string;
}

export interface CommandRetentionPolicy {
  readonly maxCommands: number;
  readonly maxAgeMs: number;
  readonly maxSensitiveAgeMs: number;
  readonly maxByteCharge: number;
}

export const DEFAULT_COMMAND_RETENTION: CommandRetentionPolicy = {
  maxCommands: 100,
  maxAgeMs: 30 * 24 * 60 * 60 * 1_000,
  maxSensitiveAgeMs: 7 * 24 * 60 * 60 * 1_000,
  maxByteCharge: 2 * 1024 * 1024 * 1024,
};

function parseRow(row: CommandRow): CommandRecord {
  return {
    sequence: row.sequence,
    recordId: row.record_id,
    activityEventId: row.activity_event_id,
    commandId: row.command_id as CommandId,
    classification: row.classification,
    inverse: JSON.parse(row.inverse_json) as InverseParameters,
    stack: row.stack,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    sensitiveExpiresAt: row.sensitive_expires_at,
    byteCharge: row.byte_charge,
  };
}

function emptyCapability(): CapabilitySnapshot {
  return {
    recordId: null,
    commandId: null,
    classification: null,
    status: 'unavailable',
    reason: 'empty-stack',
    expiresAt: null,
  };
}

export class CommandRepository {
  constructor(
    private readonly db: BetterSqlite3.Database,
    private readonly policy: CommandRetentionPolicy = DEFAULT_COMMAND_RETENTION,
  ) {}

  transaction<T>(operation: () => T): T {
    return this.db.transaction(operation)();
  }

  append(draft: CommandRecordDraft): CommandRecord {
    const existing = this.byId(draft.recordId);
    if (existing !== undefined) return existing;
    run(this.db, "UPDATE command_records SET stack = 'discarded' WHERE stack = 'redo'");
    run(this.db, "DELETE FROM activity_retention_holds WHERE hold_id IN (SELECT record_id FROM command_records WHERE stack = 'discarded')");
    const byteCharge = draft.byteCharge ?? 0;
    const charged =
      queryGet<{ total: number }>(
        this.db,
        "SELECT coalesce(sum(byte_charge), 0) AS total FROM command_records WHERE stack != 'discarded' AND expires_at > ?",
        draft.createdAt,
      )?.total ?? 0;
    const admitted = charged + byteCharge <= this.byteBudget();
    runNamed(
      this.db,
      `INSERT INTO command_records (
         record_id, activity_event_id, command_id, classification, inverse_json,
         stack, created_at, expires_at, sensitive_expires_at, byte_charge
       ) VALUES (
         @recordId, @activityEventId, @commandId, @classification, @inverseJson,
         'undo', @createdAt, @expiresAt, @sensitiveExpiresAt, @byteCharge
       )`,
      {
        recordId: draft.recordId,
        activityEventId: draft.activityEventId,
        commandId: draft.commandId,
        classification: draft.classification,
        inverseJson: JSON.stringify(draft.inverse),
        createdAt: draft.createdAt,
        expiresAt: admitted ? draft.expiresAt : draft.createdAt,
        sensitiveExpiresAt: draft.sensitiveExpiresAt ?? null,
        byteCharge: admitted ? byteCharge : 0,
      },
    );
    if (admitted && draft.classification !== 'irreversible') {
      const holdExpiresAt =
        draft.sensitiveExpiresAt !== undefined && draft.sensitiveExpiresAt !== null && draft.sensitiveExpiresAt < draft.expiresAt
          ? draft.sensitiveExpiresAt
          : draft.expiresAt;
      run(
        this.db,
        `INSERT INTO activity_retention_holds (event_id, hold_id, expires_at) VALUES (?, ?, ?)
         ON CONFLICT (event_id, hold_id) DO UPDATE SET expires_at = excluded.expires_at`,
        draft.activityEventId,
        draft.recordId,
        holdExpiresAt,
      );
    }
    this.prune(new Date(draft.createdAt));
    const inserted = this.byId(draft.recordId);
    if (inserted === undefined) throw new Error('command record insert was not readable');
    return inserted;
  }

  private byteBudget(): number {
    try {
      const file = queryAll<{ file: string }>(this.db, 'PRAGMA database_list').find((row) => row.file !== '')?.file;
      if (file === undefined) return this.policy.maxByteCharge;
      const info = statfsSync(dirname(file));
      return Math.min(this.policy.maxByteCharge, Math.floor(info.bavail * info.bsize * 0.1));
    } catch {
      return 0;
    }
  }

  byId(recordId: string): CommandRecord | undefined {
    const row = queryGet<CommandRow>(this.db, 'SELECT * FROM command_records WHERE record_id = ?', recordId);
    return row === undefined ? undefined : parseRow(row);
  }

  top(stack: 'undo' | 'redo'): CommandRecord | undefined {
    const row = queryGet<CommandRow>(this.db, 'SELECT * FROM command_records WHERE stack = ? ORDER BY sequence DESC LIMIT 1', stack);
    return row === undefined ? undefined : parseRow(row);
  }

  capability(stack: 'undo' | 'redo', now: Date): CapabilitySnapshot {
    const record = this.top(stack);
    if (record === undefined) return emptyCapability();
    if (record.classification === 'irreversible') {
      return {
        recordId: record.recordId,
        commandId: record.commandId,
        classification: record.classification,
        status: 'irreversible',
        reason: 'irreversible',
        expiresAt: record.expiresAt,
      };
    }
    if (record.expiresAt <= now.toISOString() || (record.sensitiveExpiresAt !== null && record.sensitiveExpiresAt <= now.toISOString())) {
      return {
        recordId: record.recordId,
        commandId: record.commandId,
        classification: record.classification,
        status: 'expired',
        reason: 'expired',
        expiresAt: record.expiresAt,
      };
    }
    return {
      recordId: record.recordId,
      commandId: record.commandId,
      classification: record.classification,
      status: record.classification === 'immediately-reversible' ? 'available' : 'conditional',
      reason: 'ready',
      expiresAt: record.expiresAt,
    };
  }

  transition(recordId: string, direction: 'undo' | 'redo'): void {
    const expected = direction === 'undo' ? 'undo' : 'redo';
    const next = direction === 'undo' ? 'redo' : 'undo';
    const changed = queryGet<{ record_id: string }>(
      this.db,
      'UPDATE command_records SET stack = ? WHERE record_id = ? AND stack = ? RETURNING record_id',
      next,
      recordId,
      expected,
    );
    if (changed === undefined) throw new Error('command stack changed before execution completed');
  }

  discard(recordId: string, expected: 'undo' | 'redo'): void {
    const changed = queryGet<{ record_id: string }>(
      this.db,
      "UPDATE command_records SET stack = 'discarded' WHERE record_id = ? AND stack = ? RETURNING record_id",
      recordId,
      expected,
    );
    if (changed === undefined) throw new Error('command stack changed before compensation completed');
    run(this.db, 'DELETE FROM activity_retention_holds WHERE hold_id = ?', recordId);
  }

  execution(requestId: string): HistoryExecutionResult | undefined {
    const row = queryGet<ExecutionRow>(this.db, 'SELECT result_json FROM command_executions WHERE request_id = ?', requestId);
    return row === undefined ? undefined : (JSON.parse(row.result_json) as HistoryExecutionResult);
  }

  rememberExecution(requestId: string, recordId: string, result: HistoryExecutionResult, createdAt: string): void {
    runNamed(
      this.db,
      `INSERT INTO command_executions (request_id, record_id, direction, result_json, created_at)
       VALUES (@requestId, @recordId, @direction, @resultJson, @createdAt)`,
      { requestId, recordId, direction: result.direction, resultJson: JSON.stringify(result), createdAt },
    );
  }

  prune(now: Date): number {
    const nowIso = now.toISOString();
    const ageCutoff = new Date(now.getTime() - this.policy.maxAgeMs).toISOString();
    const sensitiveCutoff = new Date(now.getTime() - this.policy.maxSensitiveAgeMs).toISOString();
    const rows = queryAll<CommandRow>(this.db, 'SELECT * FROM command_records ORDER BY sequence DESC');
    const remove = rows.filter((row, index) => index >= this.policy.maxCommands || row.created_at < ageCutoff).map((row) => row.record_id);
    for (const recordId of remove) {
      run(this.db, "UPDATE command_records SET stack = 'discarded', byte_charge = 0 WHERE record_id = ?", recordId);
      run(this.db, 'DELETE FROM activity_retention_holds WHERE hold_id = ?', recordId);
    }
    for (const row of rows) {
      if (row.sensitive_expires_at !== null && (row.sensitive_expires_at <= nowIso || row.created_at < sensitiveCutoff)) {
        const inverse = JSON.parse(row.inverse_json) as InverseParameters;
        if (inverse.kind === 'move-compensation' && inverse.sourcePath !== '') {
          runNamed(
            this.db,
            `UPDATE command_records SET inverse_json = @inverseJson, byte_charge = 0, expires_at = @now
             WHERE record_id = @recordId`,
            {
              recordId: row.record_id,
              now: nowIso,
              inverseJson: JSON.stringify({ ...inverse, sourcePath: '', parentIdentity: '' }),
            },
          );
        }
      }
    }
    return remove.length;
  }
}
