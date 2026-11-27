import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

import type { ActivityFacade } from '../activity/activity-publication.js';
import { applicationEvents } from '../application-events.js';
import { PhotosRepository } from '../db/photos-repository.js';
import { SidecarRepository } from '../db/sidecar-repository.js';
import { DisclosureService } from './disclosure-service.js';
import type { BlobStore } from '../blobs/blob-store.js';
import type { KeyResolver } from '../crypto/envelope.js';

// Composition-root wiring for the disclosure policy (#509), kept out of
// index.ts for its file budget. Audit lines go to the console like the
// keyring's; policy changes go to activity history by field name only.
export function createDisclosureService(options: {
  readonly db: BetterSqlite3.Database;
  readonly activity: () => ActivityFacade | undefined;
  readonly blobStore: BlobStore;
  readonly resolveKey: KeyResolver;
}): DisclosureService {
  const photos = new PhotosRepository(options.db);
  const sidecars = new SidecarRepository(options.db);
  return new DisclosureService({
    db: options.db,
    getPhoto: (photoId) => photos.get(photoId),
    exportableIds: () => photos.exportableIds(),
    sourceSidecars: {
      sidecarsFor: (photoId) => sidecars.listForPhoto(photoId),
      sidecarStream: (ownerId, contentHash) => options.blobStore.getSidecarStream(ownerId, contentHash, options.resolveKey),
    },
    activity: options.activity,
    changed: () => applicationEvents.libraryChanged({ photoIds: [], membership: 'none' }),
    audit: (line) => console.info(`[overlook] ${line}`),
  });
}
