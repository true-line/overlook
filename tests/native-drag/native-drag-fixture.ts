import type { PhotoRecord } from '../../src/shared/library/types.js';
import type { NativeDragBridge, NativeDragStartInput } from '../../src/main/native-drag/native-drag-bridge.js';
import {
  BOUNDARY_FIELDS,
  compileDisclosurePlan,
  DEFAULT_DISCLOSURE_POLICY,
  disclosureFieldClassesSchema,
} from '../../src/shared/disclosure/policy.js';

export const defaultPlanner = {
  plan: () =>
    compileDisclosurePlan({
      boundary: 'export',
      destination: 'public',
      chain: {
        library: {
          ...DEFAULT_DISCLOSURE_POLICY,
          fields: disclosureFieldClassesSchema.parse({
            ...DEFAULT_DISCLOSURE_POLICY.fields,
            ...Object.fromEntries(BOUNDARY_FIELDS.export.map((field) => [field, 'public'])),
          }),
        },
      },
    }),
};

export function photo(id: string, fileName = `${id}.JPG`): PhotoRecord {
  return {
    id,
    fileName,
    fileKind: 'jpeg',
    width: 1,
    height: 1,
    bytes: 5,
    contentHash: id.padEnd(64, '0'),
    derivativeKey: id.padEnd(64, '0'),
    variantSourceId: null,
    assetOwnerId: null,
    camera: null,
    lens: null,
    iso: null,
    aperture: null,
    shutter: null,
    focalLength: null,
    takenAt: null,
    gpsLat: null,
    gpsLon: null,
    place: null,
    title: null,
    description: null,
    tags: [],
    userTags: [],
    importedKeywords: [],
    suppressedKeywords: [],
    metadataVersion: 1,
    importedAt: '2026-01-01T00:00:00.000Z',
    importSource: '/source',
    favorite: false,
    isOriginal: false,
    keyId: 1,
    deletedAt: null,
    previewFailure: null,
    dimensionStatus: 'verified',
    mediaInfo: null,
    syncState: 'local',
    coverage: 'included',
    locked: false,
  };
}

export class FakeBridge implements NativeDragBridge {
  input: NativeDragStartInput | null = null;
  available = true;
  cancels = 0;
  closes = 0;

  status() {
    return this.available ? ({ available: true, reason: null } as const) : ({ available: false, reason: 'native-unavailable' } as const);
  }

  start(input: NativeDragStartInput): boolean {
    this.input = input;
    return this.available;
  }

  cancelAll(): void {
    this.cancels += 1;
  }

  close(): void {
    this.closes += 1;
  }
}
