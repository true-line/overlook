import { migrateRetainedPhotoKeys } from './retained-photo-keys.js';
import { migrateRestoredExclusion } from './restored-exclusion-migration.js';
import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

import { migrateOriginalAvailability } from './original-availability.js';
import { migrateAlbumFolders } from './album-folder-migration.js';
import { migrateAlbumVisibility } from './album-visibility-migration.js';
import { migrateGalleryPolicy } from './gallery-policy-migration.js';
import { migrateSmartAlbums } from './smart-album-migration.js';
import { migrateEditBakeDebt, migrateEditRevisions } from './edit-revision-migration.js';
import { migratePhotoProvenance } from './provenance-migration.js';
import { migrateVariants } from './variant-migration.js';
import { migratePerceptualFingerprints } from './fingerprint-migration.js';
import { migrateBackupCoverage } from './coverage-migration.js';
import { migrateLibraryKeyring } from './keyring-migration.js';
import { migratePurgeCleanup } from './purge-cleanup-migration.js';
import { migrateProtectedVariantSources } from './protected-variant-migration.js';
import { migrateDisclosurePolicy } from './disclosure-migration.js';
import { migrateConfirmedPreviewAbsence, migratePreviewRepairDebt } from './preview-repair-migration.js';
import { migrateSidecarOwners } from './sidecar-owner-migration.js';
import { migratePendingManifestPublication } from './manifest-publication-migration.js';

// ADR-0030 collection migrations (27..30), kept together so `migrations.ts`
// stays a ledger: gallery inclusion rules (#512), collection visibility
// (#494), folders + organizational tags (#505), and Smart Albums (#514).
// ADR-0031 §2/§8 edit revisions (#493) follow as 31 and §5 provenance
// evidence (#495) as 32 and §1/§3 variants (#496) as 33 — a table rebuild,
// so the runner drops foreign keys around it and checks them before commit.
export const COLLECTION_MIGRATIONS: readonly {
  readonly version: number;
  readonly name: string;
  readonly up: (db: BetterSqlite3.Database) => void;
  readonly rebuild?: boolean;
}[] = [
  { version: 27, name: 'gallery-policy', up: migrateGalleryPolicy },
  { version: 28, name: 'album-visibility', up: migrateAlbumVisibility },
  { version: 29, name: 'album-folders', up: migrateAlbumFolders },
  { version: 30, name: 'smart-albums', up: migrateSmartAlbums },
  { version: 31, name: 'edit-revisions', up: migrateEditRevisions },
  { version: 32, name: 'photo-provenance', up: migratePhotoProvenance },
  { version: 33, name: 'variants', up: migrateVariants, rebuild: true },
  // #650 perceptual fingerprints: recomputable index rows beside the photo.
  { version: 34, name: 'perceptual-fingerprints', up: migratePerceptualFingerprints },
  // #506 backup coverage: per-row inclusion in automatic backup (ADR-0033).
  { version: 35, name: 'backup-coverage', up: migrateBackupCoverage },
  // #517 keyring registry: kind, reference, version, fingerprint, label,
  // origin and per-device presence for every key (ADR-0032 §2).
  { version: 36, name: 'library-keyring', up: migrateLibraryKeyring },
  // #509 disclosure classes: the versioned per-field policy and its
  // collection/photo overrides (ADR-0032 §6).
  { version: 37, name: 'disclosure-policy', up: migrateDisclosurePolicy },
  { version: 38, name: 'protected-variant-sources', up: migrateProtectedVariantSources },
  { version: 39, name: 'purge-remote-cleanup', up: migratePurgeCleanup },
  { version: 40, name: 'shared-sidecar-custody', up: migrateSidecarOwners },
  { version: 41, name: 'deferred-variant-previews', up: migratePreviewRepairDebt },
  { version: 42, name: 'confirmed-preview-absence', up: migrateConfirmedPreviewAbsence },
  {
    version: 43,
    name: 'pending-manifest-publication',
    up: migratePendingManifestPublication,
  },
  { version: 44, name: 'deferred-edit-bakes', up: migrateEditBakeDebt },
  { version: 45, name: 'original-availability', up: migrateOriginalAvailability },
  // #1101 retained photo key references: keeps derivative envelopes represented
  // in key-removal checks after an original is recovered.
  { version: 46, name: 'retained-photo-keys', up: migrateRetainedPhotoKeys },
  { version: 47, name: 'restored-exclusion-provenance', up: migrateRestoredExclusion },
];
