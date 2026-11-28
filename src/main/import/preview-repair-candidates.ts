import type { PhotosRepository, PreviewRepairCandidatePage } from '../db/photos-repository.js';
import type { PhotoRecord } from '../../shared/library/types.js';

const BATCH_SIZE = 64;

/** No live SQLite iterator/transaction crosses a repair await. Selection keeps
 * its existing ordering while materializing only one bounded page at a time. */
export function* iteratePreviewRepairCandidates(
  repository: Pick<PhotosRepository, 'previewRepairCandidates'>,
  signal: AbortSignal,
  hashes?: readonly string[],
  photoIds?: readonly string[],
): Generator<PhotoRecord, void, undefined> {
  let after: PreviewRepairCandidatePage['after'];
  while (!signal.aborted) {
    const photos = repository.previewRepairCandidates(hashes, photoIds, {
      limit: BATCH_SIZE,
      ...(after === undefined ? {} : { after }),
    });
    for (const photo of photos) {
      if (signal.aborted) return;
      yield photo;
    }
    const last = photos.at(-1);
    if (photos.length < BATCH_SIZE || last === undefined) return;
    after = { importedAt: last.importedAt, id: last.id };
  }
}
