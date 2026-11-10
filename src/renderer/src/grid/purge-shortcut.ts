import { resolveCommand, type CommandPlatform } from '../../../shared/commands/registry.js';
import type { PhotoRecord } from '../../../shared/library/types.js';

interface PurgeShortcutOptions {
  readonly event: KeyboardEvent;
  readonly inTrash: boolean;
  readonly lightboxId: string | null;
  readonly selection: ReadonlySet<string>;
  readonly photos: readonly Pick<PhotoRecord, 'id' | 'isOriginal'>[];
  readonly dialogOpen: boolean;
  readonly originalDeleteOpen: boolean;
  readonly platform: CommandPlatform;
  readonly onPurge: (ids: string[]) => void;
  readonly onOriginalDelete: (ids: string[]) => void;
  readonly originalDeletePreflight: (request: { photoIds: string[] }) => Promise<{ challengeId: string }>;
  readonly originalDeleteCancel: (request: { challengeId: string }) => Promise<unknown>;
}

export function handlePurgeShortcut(options: PurgeShortcutOptions): void {
  const { event, inTrash, lightboxId, selection, photos, dialogOpen, originalDeleteOpen, platform } = options;
  if (event.defaultPrevented || originalDeleteOpen) return;
  const editable =
    event.target instanceof HTMLElement && event.target.closest('input, textarea, select, [contenteditable="true"]') !== null;
  const command = resolveCommand(event, {
    surface: lightboxId === null ? 'grid' : 'lightbox',
    dialogOpen,
    editable,
    platform,
  });
  if (command?.id !== 'photo.purge') return;
  const targetIds = lightboxId !== null ? [lightboxId] : [...selection];
  if (targetIds.length === 0) return;
  if (photos.some((photo) => targetIds.includes(photo.id) && photo.isOriginal)) {
    event.preventDefault();
    options.onOriginalDelete(targetIds);
    return;
  }
  // A complete Select All spans unloaded pages (#884), so loaded rows can
  // never rule a protected Original out. Main owns that answer: preflight
  // rejects a selection with nothing protected, and the probe challenge is
  // cancelled straight away so the dialog opens its own ceremony.
  const loaded = new Set(photos.map(({ id }) => id));
  if (targetIds.every((id) => loaded.has(id))) {
    if (!inTrash) return;
    event.preventDefault();
    options.onPurge(targetIds);
    return;
  }
  event.preventDefault();
  void options
    .originalDeletePreflight({ photoIds: targetIds })
    .then(({ challengeId }) => {
      void options.originalDeleteCancel({ challengeId });
      options.onOriginalDelete(targetIds);
    })
    .catch(() => {
      // Nothing protected in the unloaded pages: open Trash purge confirmation
      // when in Trash, and remain a no-op outside Trash.
      if (inTrash) options.onPurge(targetIds);
    });
}
