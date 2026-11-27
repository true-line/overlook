import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';

import { openLibraryDatabase } from '../../src/main/db/database.js';
import { PhotosRepository } from '../../src/main/db/photos-repository.js';
import { run } from '../../src/main/db/sql.js';
import { DisclosureConsentAuthority } from '../../src/main/disclosure/disclosure-consent.js';
import type { SourceSidecarReader } from '../../src/main/disclosure/source-sidecars.js';
import { DisclosureService } from '../../src/main/disclosure/disclosure-service.js';
import type { DisclosurePreviewRequest } from '../../src/shared/ipc/disclosure-channels.js';
import type { ExportDisclosureIntentWire } from '../../src/shared/ipc/export-channels.js';

export function consentFixture(t: TestContext, sourceSidecars?: SourceSidecarReader) {
  const directory = mkdtempSync(join(tmpdir(), 'overlook-consent-'));
  const db = openLibraryDatabase({ path: join(directory, 'library.db'), dbKey: randomBytes(32) });
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  run(db, "INSERT INTO keys (id, wrapped_key, created_at) VALUES (1, 'test', '2026-09-02T00:00:00Z')");
  const photos = new PhotosRepository(db);
  for (const id of ['P1', 'P2'])
    photos.insert({
      id,
      fileName: `${id}.JPG`,
      fileKind: 'jpeg',
      width: 30,
      height: 20,
      bytes: 10,
      contentHash: id.padEnd(64, '0'),
      camera: null,
      lens: null,
      iso: null,
      aperture: null,
      shutter: null,
      focalLength: null,
      takenAt: null,
      gpsLat: 52.37,
      gpsLon: 4.9,
      place: null,
      importedAt: '2026-09-02T00:00:00Z',
      importSource: 'camera',
      favorite: false,
      keyId: 1,
    });
  let ids = ['P1'];
  const service = new DisclosureService({
    sourceSidecars,
    db,
    getPhoto: (id) => photos.get(id),
    exportableIds: () => ids,
    audit: () => undefined,
  });
  const state = { epoch: 0, library: 'library-1', allowed: true, now: 0, confirmed: true };
  const prompts: string[] = [];
  let confirm: (detail: string) => Promise<boolean> = () => Promise.resolve(state.confirmed);
  const authority = new DisclosureConsentAuthority({
    getService: () => service,
    admit: () => {
      if (!state.allowed) throw new Error('locked');
    },
    libraryId: () => state.library,
    authorizationEpoch: () => state.epoch,
    now: () => state.now,
    confirm: (detail) => {
      prompts.push(detail);
      return confirm(detail);
    },
  });
  const request = (boundary: 'export' | 'photo-kit' = 'export'): DisclosurePreviewRequest => ({
    boundary,
    destination: 'shared',
    photoIds: ['P1'],
    payload: 'original',
    mode: 'original',
    metadata: 'original',
    operation: { narrow: [], widen: ['location'] },
  });
  const wire = (consent?: string): ExportDisclosureIntentWire => ({
    destination: 'shared',
    operation: { narrow: [], widen: [] },
    ...(consent === undefined ? {} : { consent }),
  });
  return {
    db,
    photos,
    service,
    authority,
    state,
    prompts,
    request,
    wire,
    setIds: (next: string[]) => {
      ids = next;
    },
    setConfirm: (next: typeof confirm) => {
      confirm = next;
    },
  };
}
