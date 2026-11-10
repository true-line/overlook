import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

import type {
  CapabilityReason,
  CapabilitySnapshot,
  CommandRecord,
  HistoryExecutionResult,
  HistoryStatus,
} from '../../shared/history/types.js';
import type { LibraryService } from '../library/library-service.js';
import { parseBoard, serializeBoard } from '../../shared/moodboard/board.js';
import { enforceActivityRetention } from '../activity/activity-publication.js';
import { ActivityRepository, type ActivityRetentionPolicy } from '../activity/activity-repository.js';
import { ulid } from '../import/ulid.js';
import { CommandRepository } from './command-repository.js';
import { MoveCompensationError } from './move-compensation-runtime.js';

export interface MoveCompensationRuntime {
  capability(record: Extract<CommandRecord['inverse'], { kind: 'move-compensation' }>): CapabilityReason | 'ready';
  restore(record: Extract<CommandRecord['inverse'], { kind: 'move-compensation' }>): Promise<'restored' | 'already-restored'>;
}

function unavailable(capability: CapabilitySnapshot, reason: CapabilityReason): CapabilitySnapshot {
  return { ...capability, status: 'unavailable', reason };
}

function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

export class HistoryService {
  private readonly commands: CommandRepository;
  private readonly activity: ActivityRepository;

  constructor(
    db: BetterSqlite3.Database,
    private readonly library: LibraryService,
    private readonly move?: MoveCompensationRuntime,
    private readonly onManifestChanged?: () => void,
    private readonly onBoardsChanged?: (boardId: string) => void,
    retentionPolicy?: ActivityRetentionPolicy,
  ) {
    this.commands = new CommandRepository(db);
    this.activity = new ActivityRepository(db, retentionPolicy);
  }

  status(now = new Date()): HistoryStatus {
    this.commands.prune(now);
    return { undo: this.revalidate('undo', now), redo: this.revalidate('redo', now) };
  }

  undo(requestId: string): Promise<HistoryExecutionResult> {
    return this.execute('undo', requestId);
  }

  redo(requestId: string): Promise<HistoryExecutionResult> {
    return this.execute('redo', requestId);
  }

  private revalidate(stack: 'undo' | 'redo', now: Date): CapabilitySnapshot {
    const capability = this.commands.capability(stack, now);
    if (capability.reason !== 'ready' || capability.recordId === null) return capability;
    const record = this.commands.byId(capability.recordId);
    if (record === undefined) return unavailable(capability, 'resource-missing');
    const direction = stack === 'undo' ? 'undo' : 'redo';
    if (record.inverse.kind === 'move-compensation') {
      if (this.move === undefined) return unavailable(capability, 'bytes-unavailable');
      const reason = this.move.capability(record.inverse);
      return reason === 'ready' ? capability : unavailable(capability, reason);
    }
    switch (record.inverse.kind) {
      case 'favorite': {
        const source = direction === 'undo' ? record.inverse.after : record.inverse.before;
        const target = direction === 'undo' ? record.inverse.before : record.inverse.after;
        const current = this.library.favoriteState(record.inverse.photoId);
        if (current === undefined) return unavailable(capability, 'resource-missing');
        return current === source || current === target ? capability : unavailable(capability, 'state-changed');
      }
      case 'favorites': {
        const changes = record.inverse.changes;
        const states = changes.map(({ photoId }) => this.library.favoriteState(photoId));
        if (states.some((state) => state === undefined)) return unavailable(capability, 'resource-missing');
        const matchesBefore = states.every((state, index) => state === changes[index]?.before);
        const matchesAfter = states.every((state, index) => state === changes[index]?.after);
        return matchesBefore || matchesAfter ? capability : unavailable(capability, 'state-changed');
      }
      case 'album-membership': {
        const source = direction === 'undo' ? record.inverse.after : record.inverse.before;
        const target = direction === 'undo' ? record.inverse.before : record.inverse.after;
        const expectedSource = source === 'present';
        const expectedTarget = target === 'present';
        const membership = this.library.albumMembership(record.inverse.albumId, record.inverse.photoIds);
        if (membership === undefined) return unavailable(capability, 'resource-missing');
        const states = [...membership.values()];
        if (states.every((state) => state === expectedSource) || states.every((state) => state === expectedTarget)) return capability;
        return unavailable(capability, 'state-changed');
      }
      case 'trash': {
        const source = direction === 'undo' ? record.inverse.after : record.inverse.before;
        const target = direction === 'undo' ? record.inverse.before : record.inverse.after;
        const states = [...this.library.trashState(record.inverse.photoIds).values()];
        if (states.includes('missing')) return unavailable(capability, 'resource-missing');
        if (states.every((state) => state === source) || states.every((state) => state === target)) return capability;
        return unavailable(capability, 'state-changed');
      }
      case 'album-order': {
        const current = this.library.albumOrder();
        if (!current.includes(record.inverse.albumId)) return unavailable(capability, 'resource-missing');
        const expectedSource = direction === 'undo' ? record.inverse.after : record.inverse.before;
        const expectedTarget = direction === 'undo' ? record.inverse.before : record.inverse.after;
        return sameOrder(current, expectedSource) || sameOrder(current, expectedTarget)
          ? capability
          : unavailable(capability, 'state-changed');
      }
      case 'board-layout': {
        const current = this.library.getBoard(record.inverse.boardId);
        if (current === null) return unavailable(capability, 'resource-missing');
        const serialized = serializeBoard(current);
        return serialized === record.inverse.before || serialized === record.inverse.after
          ? capability
          : unavailable(capability, 'state-changed');
      }
    }
  }

  private async execute(direction: 'undo' | 'redo', requestId: string): Promise<HistoryExecutionResult> {
    const existing = this.commands.execution(requestId);
    if (existing !== undefined) return existing;
    const now = new Date();
    const record = this.commands.top(direction === 'undo' ? 'undo' : 'redo');
    const capability = this.revalidate(direction === 'undo' ? 'undo' : 'redo', now);
    if (record === undefined) return { applied: false, direction, capability };

    if (record.inverse.kind === 'move-compensation') {
      if (direction === 'redo') {
        return { applied: false, direction, capability: unavailable(capability, 'irreversible') };
      }
      if (this.move === undefined) return { applied: false, direction, capability: unavailable(capability, 'bytes-unavailable') };
      if (capability.reason !== 'ready' && capability.reason !== 'path-occupied') return { applied: false, direction, capability };
      try {
        await this.move.restore(record.inverse);
      } catch (error) {
        if (error instanceof MoveCompensationError) {
          return { applied: false, direction, capability: unavailable(capability, error.reason) };
        }
        throw error;
      }
      const result = this.commands.transaction(() => this.complete(record, direction, requestId, capability, now, 'command.compensated'));
      this.onManifestChanged?.();
      return result;
    }

    if (capability.reason !== 'ready') return { applied: false, direction, capability };

    const result = this.commands.transaction(() => {
      this.applyLibraryChange(record, direction);
      return this.complete(record, direction, requestId, capability, now, direction === 'undo' ? 'command.undone' : 'command.redone');
    });
    // Every committed Undo/Redo mutates manifest-backed state (`trash` both
    // 'live' and 'trashed', `favorite`, `favorites`, `album-membership`,
    // `album-order`, `board-layout`, plus the appended activity event).
    this.onManifestChanged?.();
    if (record.inverse.kind === 'board-layout') {
      this.onBoardsChanged?.(record.inverse.boardId);
    }
    return result;
  }

  private complete(
    record: CommandRecord,
    direction: 'undo' | 'redo',
    requestId: string,
    capability: CapabilitySnapshot,
    now: Date,
    eventType: 'command.undone' | 'command.redone' | 'command.compensated',
  ): HistoryExecutionResult {
    const result: HistoryExecutionResult = { applied: true, direction, capability };
    const operationId = `history:${requestId}`;
    this.activity.append({
      eventId: ulid(),
      operationId,
      eventType,
      occurredAt: now.toISOString(),
      rootCorrelationId: operationId,
      causationEventId: record.activityEventId,
      entityIds: this.entityIds(record),
      outcome: 'succeeded',
      payload: { commandId: record.commandId },
    });
    if (eventType === 'command.compensated') this.commands.discard(record.recordId, 'undo');
    else this.commands.transition(record.recordId, direction);
    this.commands.rememberExecution(requestId, record.recordId, result, now.toISOString());
    enforceActivityRetention(this.activity, now);
    return result;
  }

  private applyLibraryChange(record: CommandRecord, direction: 'undo' | 'redo'): void {
    switch (record.inverse.kind) {
      case 'favorite': {
        const target = direction === 'undo' ? record.inverse.before : record.inverse.after;
        this.library.setFavorite(record.inverse.photoId, target);
        break;
      }
      case 'favorites': {
        this.library.setFavorites(
          record.inverse.changes.map(({ photoId, before, after }) => ({
            photoId,
            favorite: direction === 'undo' ? before : after,
          })),
        );
        break;
      }
      case 'album-membership': {
        const target = direction === 'undo' ? record.inverse.before : record.inverse.after;
        if (target === 'present') this.library.addToAlbum(record.inverse.albumId, record.inverse.photoIds);
        else this.library.removeFromAlbum(record.inverse.albumId, record.inverse.photoIds);
        break;
      }
      case 'trash': {
        const target = direction === 'undo' ? record.inverse.before : record.inverse.after;
        if (target === 'trashed') this.library.deletePhotos(record.inverse.photoIds);
        else this.library.restorePhotos(record.inverse.photoIds);
        break;
      }
      case 'album-order': {
        const target = direction === 'undo' ? record.inverse.before : record.inverse.after;
        this.library.setAlbumOrder(target);
        break;
      }
      case 'board-layout': {
        const target = direction === 'undo' ? record.inverse.before : record.inverse.after;
        this.library.saveBoard(parseBoard(target));
        break;
      }
      case 'move-compensation':
        throw new Error('Move compensation is asynchronous');
    }
  }

  private entityIds(record: CommandRecord): readonly string[] {
    switch (record.inverse.kind) {
      case 'favorite':
      case 'move-compensation':
        return [record.inverse.photoId];
      case 'favorites':
        return record.inverse.changes.map(({ photoId }) => photoId);
      case 'album-membership':
        return [record.inverse.albumId, ...record.inverse.photoIds];
      case 'trash':
        return record.inverse.photoIds;
      case 'album-order':
        return [record.inverse.albumId];
      case 'board-layout':
        return [record.inverse.boardId];
    }
  }
}
