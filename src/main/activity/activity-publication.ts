import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

import type { ActivityAppend, ActivityEvent, ActivityEventType, ActivityOutcome, ActivityPage } from '../../shared/activity/types.js';
import type { CommandClassification, InverseParameters } from '../../shared/history/types.js';
import type { CommandId } from '../../shared/commands/registry.js';
import { ActivityRepository } from './activity-repository.js';
import { CommandRepository, DEFAULT_COMMAND_RETENTION } from '../history/command-repository.js';
import { ulid } from '../import/ulid.js';

export type ActivityDraft = {
  readonly eventType: ActivityEventType;
  readonly entityIds?: readonly string[];
  readonly outcome: ActivityOutcome;
  readonly payload?: ActivityAppend['payload'];
};

export interface CommandDraft {
  readonly commandId: CommandId;
  readonly classification: CommandClassification;
  readonly inverse: InverseParameters;
  readonly byteCharge?: number;
  readonly sensitive?: boolean;
}

export interface ActivityFacade {
  page(limit: number, cursor?: number): ActivityPage;
  record(event: ActivityDraft, command?: CommandDraft | readonly CommandDraft[]): void;
  recordMutation<T>(
    mutation: () => T,
    activity: (result: T) => ActivityDraft | undefined,
    command?: (result: T) => CommandDraft | readonly CommandDraft[] | undefined,
  ): T;
}

export function mutateWithActivity<T>(
  getActivity: (() => ActivityFacade) | undefined,
  mutation: () => T,
  activity: (result: T) => ActivityDraft | undefined,
  command?: (result: T) => CommandDraft | readonly CommandDraft[] | undefined,
): T {
  return getActivity === undefined ? mutation() : getActivity().recordMutation(mutation, activity, command);
}

function materialize(event: ActivityDraft, now = new Date()): ActivityAppend {
  const operationId = ulid();
  return {
    ...event,
    eventId: ulid(),
    operationId,
    rootCorrelationId: operationId,
    occurredAt: now.toISOString(),
  };
}

export function enforceActivityRetention(repository: ActivityRepository, now = new Date()): boolean {
  const pruned = repository.prune(now);
  if (pruned === 0) return false;
  repository.append(materialize({ eventType: 'activity.pruned', outcome: 'succeeded', payload: { count: pruned } }, now));
  repository.prune(now);
  return true;
}

function materializeCommand(command: CommandDraft, activity: ActivityEvent): Parameters<CommandRepository['append']>[0] {
  const created = new Date(activity.occurredAt);
  return {
    recordId: ulid(),
    activityEventId: activity.eventId,
    commandId: command.commandId,
    classification: command.classification,
    inverse: command.inverse,
    createdAt: activity.occurredAt,
    expiresAt: new Date(created.getTime() + DEFAULT_COMMAND_RETENTION.maxAgeMs).toISOString(),
    sensitiveExpiresAt: command.sensitive ? new Date(created.getTime() + DEFAULT_COMMAND_RETENTION.maxSensitiveAgeMs).toISOString() : null,
    byteCharge: command.byteCharge ?? 0,
  };
}

export function activityBackupSnapshot(db: BetterSqlite3.Database): readonly ActivityEvent[] {
  const repository = new ActivityRepository(db);
  repository.flushPending();
  enforceActivityRetention(repository);
  return repository.backupSnapshot();
}

export function createActivityFacade(db: BetterSqlite3.Database, onChanged: () => void): ActivityFacade {
  const repository = new ActivityRepository(db);
  const commands = new CommandRepository(db);
  const append = (event: ActivityDraft): ActivityEvent => {
    const appended = repository.append(materialize(event));
    enforceActivityRetention(repository);
    return appended;
  };
  return {
    page: (limit, cursor) => {
      const published = repository.flushPending();
      const changed = enforceActivityRetention(repository);
      if (published > 0 || changed) onChanged();
      return repository.page(limit, cursor);
    },
    record: (event, command) => {
      const flushed = repository.flushPending();
      let status: 'published' | 'pending' | 'unavailable';
      try {
        repository.transaction(() => {
          const appended = append(event);
          const drafts: readonly CommandDraft[] = command === undefined ? [] : 'commandId' in command ? [command] : command;
          for (const draft of drafts) commands.append(materializeCommand(draft, appended));
        });
        status = 'published';
      } catch {
        status = repository.publishAfterBoundary(materialize(event));
      }
      if (status !== 'published') console.error('[overlook] activity publication pending', event.eventType);
      if (flushed > 0 || status !== 'unavailable') onChanged();
    },
    recordMutation: (mutation, activity, command) => {
      let recorded = false;
      const result = repository.transaction(() => {
        const completed = mutation();
        const event = activity(completed);
        if (event !== undefined) {
          const appended = append(event);
          const undoable = command?.(completed);
          const drafts = undoable === undefined ? [] : 'commandId' in undoable ? [undoable] : undoable;
          for (const draft of drafts) commands.append(materializeCommand(draft, appended));
          recorded = true;
        }
        return completed;
      });
      if (recorded) onChanged();
      return result;
    },
  };
}
