import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { Inspector } from './Inspector';
import type { OverlookApi } from '../../../shared/ipc/api.js';
import type { VariantFamilyView } from './use-photo-variants';
import type { PhotoRecord } from '../../../shared/library/types.js';
import type { PhotoCustodyStatus } from '../../../shared/backup/custody-status.js';
import type { HistogramPayload } from '../../../shared/ipc/histogram-channels.js';
import type { ProvenancePayload } from '../../../shared/ipc/provenance-channels.js';
import { PROVENANCE_EVALUATOR, type ProvenanceSource } from '../../../shared/library/provenance.js';

// #94 exit criteria: §4 visual match — grouped truth rows, interpunct mono
// values, RAF → RAW badge, missing EXIF rows OMITTED (never fabricated).

const PHOTO: PhotoRecord = {
  id: '01J8SEEDPHOTO0000',
  fileName: 'IMG_4021.RAF',
  fileKind: 'raw',
  mediaInfo: null,
  width: 6240,
  height: 4160,
  bytes: 8_400_000,
  contentHash: 'a'.repeat(64),
  derivativeKey: 'a'.repeat(64),
  variantSourceId: null,
  assetOwnerId: null,
  camera: 'FUJIFILM X-T5',
  lens: 'XF 35MM F/1.4',
  iso: 200,
  aperture: '1.4',
  shutter: '1/250',
  focalLength: 35,
  takenAt: '2026-06-12T12:34:56',
  gpsLat: null,
  gpsLon: null,
  place: 'Lisbon',
  importedAt: '2026-07-02T00:00:00.000Z',
  importSource: 'SD card',
  favorite: true,
  isOriginal: false,
  keyId: 2,
  deletedAt: null,
  previewFailure: null,
  dimensionStatus: 'verified',
  syncState: 'synced',
  coverage: 'included',
  locked: false,
  title: 'Lisbon morning',
  description: 'Street scene near the waterfront.',
  tags: ['Lisbon', 'Travel'],
  userTags: ['Travel'],
  importedKeywords: ['Lisbon'],
  suppressedKeywords: [],
  metadataVersion: 1,
};

// #495: provenance evidence as main would report it, per tier. The stories
// stub the bridge because no fixture can produce Verified or Detected from
// bytes in a build without a validator or detector.
function provenanceOf(
  tier: 'verified' | 'declared' | 'detected' | 'unknown',
  sources: readonly ProvenanceSource[],
  extra: Partial<ProvenancePayload> = {},
): ProvenancePayload {
  return {
    photoId: PHOTO.id,
    evidence: {
      version: 1,
      subjectHash: PHOTO.contentHash,
      evaluator: PROVENANCE_EVALUATOR,
      evaluatedAt: '2026-09-02T10:00:00.000Z',
      network: false,
      tier,
      sources,
    },
    unsupported: null,
    stale: false,
    status: 'evaluated',
    ...extra,
  };
}

// #498: a histogram as main would report it — four bell curves so the
// overlaid traces are legible, small shadow clipping and highlight clipping
// above the amber threshold.
function histogramOf(photoId: string): HistogramPayload {
  const bell = (center: number, width: number): number[] =>
    Array.from({ length: 256 }, (_, index) => Math.round(1000 * Math.exp(-(((index - center) / width) ** 2))));
  return {
    state: 'ready',
    photoId,
    revisionId: null,
    source: 'mid',
    width: 2048,
    height: 1365,
    pixels: 2048 * 1365,
    channels: { red: bell(96, 40), green: bell(128, 44), blue: bell(160, 48), luma: bell(122, 42) },
    clipping: { shadows: { red: 0.002, green: 0.001, blue: 0 }, highlights: { red: 0.014, green: 0.01, blue: 0.005 } },
    digest: 'story001',
  };
}

const meta: Meta<typeof Inspector> = {
  title: 'App/Inspector',
  component: Inspector,
  decorators: [
    (Story, context) => {
      const library = {
        onChanged: () => () => undefined,
        metadataSummary: () =>
          Promise.resolve({
            found: 1,
            missing: 0,
            title: { mixed: false, value: PHOTO.title },
            description: { mixed: false, value: PHOTO.description },
            commonTags: PHOTO.tags,
            varyingTags: [],
          }),
        updateMetadata: () => Promise.resolve({ updated: 1, unchanged: 0, missing: 0, photoIds: [PHOTO.id] }),
        tagSuggestions: () =>
          Promise.resolve({
            tags: [
              { name: 'Lisbon', count: 1 },
              { name: 'Travel', count: 1 },
            ],
          }),
        manageTag: () => Promise.resolve({ updated: 1, unchanged: 0, missing: 0, photoIds: [PHOTO.id], merged: false }),
      } as unknown as OverlookApi['library'];
      const custodyStatus =
        (context.parameters['custodyStatus'] as PhotoCustodyStatus | undefined) ??
        ({ state: 'available', providerId: 'mock', providerLabel: 'Local mock', accountLabel: 'Mock account' } as const);
      const backup = {
        photoCustodyStatus: () => Promise.resolve(custodyStatus),
        onEphemeralState: () => () => undefined,
      } as unknown as OverlookApi['backup'];
      const provenancePayload = (context.parameters['provenance'] as ProvenancePayload | undefined) ?? provenanceOf('unknown', []);
      const provenance = {
        get: () => Promise.resolve(provenancePayload),
        refresh: () => Promise.resolve(provenancePayload),
      } as unknown as OverlookApi['provenance'];
      const family = (context.parameters['variants'] as VariantFamilyView | undefined) ?? {
        contentHash: PHOTO.contentHash,
        representativeId: null,
        variants: [PHOTO],
      };
      const variants = {
        family: () => Promise.resolve(family),
        promote: ({ photoId }: { photoId: string }) => Promise.resolve({ ...family, representativeId: photoId }),
        duplicate: () => Promise.resolve({ created: [], skipped: 0, unsupported: 0, pendingCount: 0 }),
      } as unknown as OverlookApi['variants'];
      const histogramPayload = (context.parameters['histogram'] as HistogramPayload | undefined) ?? histogramOf(PHOTO.id);
      const histogram = { get: () => Promise.resolve(histogramPayload) } as unknown as OverlookApi['histogram'];
      (globalThis as { overlook?: Partial<OverlookApi> }).overlook = { library, backup, provenance, variants, histogram };
      return (
        <div style={{ width: 'var(--inspector-w)', height: 480, background: 'var(--gray-1)', borderLeft: '1px solid var(--border-1)' }}>
          <Story />
        </div>
      );
    },
  ],
};

export default meta;
type Story = StoryObj<typeof Inspector>;

export const LocalOnlyHealthy: Story = {
  args: { photo: { ...PHOTO, coverage: 'excluded', syncState: 'local', localCustodyFailure: null } },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText('On this device only — not backed up by choice')).toBeVisible();
  },
};

export const LocalOriginalMissing: Story = {
  args: { photo: { ...PHOTO, coverage: 'excluded', syncState: 'local', localCustodyFailure: 'local-missing' } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Local original missing — backup remains excluded by choice')).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Recover original…' })).toBeVisible();
  },
};

export const LocalOriginalCorrupt: Story = {
  args: { photo: { ...PHOTO, coverage: 'excluded', syncState: 'local', localCustodyFailure: 'local-corrupt' } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Local original corrupt — backup remains excluded by choice')).toBeVisible();
    await expect(canvas.queryByText('On this device only — not backed up by choice')).not.toBeInTheDocument();
  },
};

export const RafFavorite: Story = {
  args: { photo: PHOTO, providerLabel: 'Local mock' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 2, name: 'Inspector' })).toBeInTheDocument();
    await expect(canvas.getByRole('heading', { level: 3, name: 'Capture' })).toBeInTheDocument();
    await expect(canvas.getByText('raw')).toBeVisible();
    await expect(canvas.getByText('Encrypted')).toBeVisible();
    await expect(canvas.getByText('Favorite')).toBeVisible();
    await expect(canvas.getByText('Jun 12, 2026 · Lisbon')).toBeVisible();
    // Interpunct-joined mono values per the copy rules.
    await expect(canvas.getByText('ƒ/1.4 · 1/250S · ISO 200')).toBeVisible();
    await expect(canvas.getByText('6240×4160 · 26.0 MP')).toBeVisible();
    await expect(canvas.getByText('Jul 2, 2026 · SD card')).toBeVisible();
    // Real key metadata + the honest synced copy (no fabricated timestamp).
    await expect(canvas.getByText('AES-256-GCM · KEY #2')).toBeVisible();
    await expect(canvas.getByText('Encrypted · Local mock')).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Copy filename' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Copy cipher identity' })).toBeVisible();
    await expect(canvas.queryByText('Dimensions mismatch — possibly corrupt metadata')).toBeNull();
  },
};

export const MetadataLite: Story = {
  args: {
    photo: {
      ...PHOTO,
      fileKind: 'jpeg',
      fileName: 'scan-0001.jpg',
      camera: null,
      lens: null,
      iso: null,
      aperture: null,
      shutter: null,
      focalLength: null,
      takenAt: null,
      place: null,
      favorite: false,
      syncState: 'local',
      coverage: 'included',
      locked: false,
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Missing EXIF rows are OMITTED — never fabricated.
    await expect(canvas.queryByText('Camera')).toBeNull();
    await expect(canvas.queryByText('Exposure')).toBeNull();
    await expect(canvas.queryByText('Favorite')).toBeNull();
    await expect(canvas.getByText('jpeg')).toBeVisible();
    await expect(canvas.getByText('Local only — not backed up')).toBeVisible();
  },
};

export const ProviderRequiredCustody: Story = {
  args: { photo: { ...PHOTO, syncState: 'offloaded' } },
  parameters: {
    custodyStatus: {
      state: 'provider-required',
      providerId: 'google-drive',
      providerLabel: 'Google Drive',
      accountLabel: 'm.rivera@gmail.com',
    } satisfies PhotoCustodyStatus,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText('Google Drive required — reconnect as m.rivera@gmail.com to recover this original.', {
        selector: 'dd.ovl-metadata-row__value',
      }),
    ).toBeVisible();
    await expect(
      canvas.getByRole('img', { name: 'Google Drive required — reconnect as m.rivera@gmail.com to recover this original.' }),
    ).toBeVisible();
  },
};

export const LegacyUnboundCustody: Story = {
  args: { photo: { ...PHOTO, syncState: 'offloaded' } },
  parameters: {
    custodyStatus: {
      state: 'legacy-unbound',
      providerId: null,
      providerLabel: null,
      accountLabel: null,
    } satisfies PhotoCustodyStatus,
  },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByText(
        'Recovery required — this legacy cloud-only original is not yet bound to a verified provider account.',
        { selector: 'dd.ovl-metadata-row__value' },
      ),
    ).toBeVisible();
  },
};

export const UnknownDimensions: Story = {
  args: { photo: { ...PHOTO, width: 0, height: 0, fileName: 'legacy-zero.jpg' } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Unknown — repair pending')).toBeVisible();
    await expect(canvas.queryByText('0×0 · 0.0 MP')).toBeNull();
  },
};

export const PossiblyCorruptMetadata: Story = {
  args: {
    photo: {
      ...PHOTO,
      fileKind: 'jpeg',
      fileName: 'metadata-mismatch.jpg',
      dimensionStatus: 'metadata-mismatch',
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Metadata')).toBeVisible();
    await expect(canvas.getByText('Dimensions mismatch — possibly corrupt metadata')).toBeVisible();
    await expect(canvas.getByText('6240×4160 · 26.0 MP')).toBeVisible();
  },
};

export const Empty: Story = {
  args: { photo: null },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText('Select a photo')).toBeVisible();
  },
};

export const MultipleSelected: Story = {
  args: {
    photo: PHOTO,
    selectionPosition: { index: 1, count: 3 },
    onPrevious: fn(),
    onNext: fn(),
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('2 of 3 selected')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Previous selected photo' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Next selected photo' }));
    await expect(args.onPrevious).toHaveBeenCalledTimes(1);
    await expect(args.onNext).toHaveBeenCalledTimes(1);
  },
};

export const EditableMetadata: Story = {
  args: { photo: PHOTO },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByDisplayValue('Lisbon morning')).toBeVisible();
    await userEvent.clear(canvas.getByLabelText('Title'));
    await userEvent.type(canvas.getByLabelText('Title'), 'Lisbon dusk');
    await userEvent.type(canvas.getByLabelText('Add tag'), 'Portfolio{enter}');
    await expect(canvas.getByRole('button', { name: 'Remove Portfolio' })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Save metadata' }));
    await expect(await canvas.findByText('Updated 1; 0 unchanged; 0 unavailable.')).toBeVisible();
  },
};

export const ProvenanceVerified: Story = {
  args: { photo: PHOTO },
  parameters: {
    provenance: provenanceOf('verified', [
      {
        kind: 'credential',
        format: 'c2pa',
        container: 'jpeg-app11',
        bytes: 18_432,
        outcome: 'valid',
        validator: 'c2pa validator 1.0 · default trust list',
        reason: 'signature and hard bindings validate for these bytes',
      },
      { kind: 'declaration', origin: 'xmp', field: 'xmp:CreatorTool', value: 'Adobe Firefly 3.0', claim: 'generated' },
    ]),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const section = await canvas.findByTestId('inspector-provenance');
    await waitFor(() => expect(section).toHaveAttribute('data-tier', 'verified'));
    await expect(canvas.getByTestId('inspector-provenance-tier')).toHaveTextContent('Verified provenance');
    await expect(canvas.getByText('Content Credentials valid for these bytes')).toBeVisible();
    await expect(canvas.getByText('Validated locally against c2pa validator 1.0 · default trust list.')).toBeVisible();
  },
};

export const ProvenanceDeclared: Story = {
  args: { photo: PHOTO },
  parameters: {
    provenance: provenanceOf('declared', [
      {
        kind: 'declaration',
        origin: 'xmp',
        field: 'Iptc4xmpExt:DigitalSourceType',
        value: 'http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia',
        claim: 'generated',
      },
      { kind: 'declaration', origin: 'exif', field: 'Software', value: 'Midjourney v6', claim: 'generated' },
    ]),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('AI-generated — declared by metadata, not verified')).toBeVisible();
    await expect(canvas.getByText('Software: Midjourney v6')).toBeVisible();
    await expect(canvas.getByText('Declarations can be added, changed, or removed by any tool. They are not proof.')).toBeVisible();
  },
};

export const ProvenanceCredentialUnverifiable: Story = {
  args: { photo: PHOTO },
  parameters: {
    provenance: provenanceOf('declared', [
      {
        kind: 'credential',
        format: 'c2pa',
        container: 'jpeg-app11',
        bytes: 18_432,
        outcome: 'unverifiable',
        validator: null,
        reason: 'credential container present; this build has no C2PA validator or trust policy',
      },
    ]),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Content Credentials present — not validated by this build')).toBeVisible();
    await expect(canvas.getByTestId('inspector-provenance-tier')).toHaveTextContent('Declared');
    await expect(canvas.queryByText('Verified provenance')).toBeNull();
  },
};

export const ProvenanceCredentialInvalid: Story = {
  args: { photo: PHOTO },
  parameters: {
    provenance: provenanceOf('declared', [
      {
        kind: 'credential',
        format: 'c2pa',
        container: 'jpeg-app11',
        bytes: 18_432,
        outcome: 'invalid',
        validator: 'c2pa validator 1.0 · default trust list',
        reason: 'hard binding does not match these bytes',
      },
    ]),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Content Credentials invalid for these bytes')).toBeVisible();
    await expect(canvas.getByTestId('inspector-provenance-tier')).toHaveTextContent('Declared');
  },
};

export const ProvenanceDetected: Story = {
  args: { photo: PHOTO },
  parameters: {
    provenance: provenanceOf('detected', [
      {
        kind: 'detector',
        name: 'watermark-detector',
        version: '2.1',
        result: 'positive',
        confidence: 0.83,
        limits: 'Trained on one generator family; recompression and crops lower recall; false positives occur on noisy scans.',
      },
    ]),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const section = await canvas.findByTestId('inspector-provenance');
    await waitFor(() => expect(section).toHaveAttribute('data-tier', 'detected'));
    await expect(canvas.getByText('Detector report — not verified')).toBeVisible();
    await expect(canvas.getByText('watermark-detector 2.1 · positive · 83%')).toBeVisible();
    await expect(canvas.getByText(/Detectors have false positives and false negatives\. Trained on one generator family/u)).toBeVisible();
  },
};

export const ProvenanceUnknownStale: Story = {
  args: { photo: PHOTO },
  parameters: { provenance: provenanceOf('unknown', [], { stale: true, status: 'deferred' }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('No supported evidence')).toBeVisible();
    await expect(canvas.getByText('Unknown is not a claim that a person made this image.')).toBeVisible();
    await expect(canvas.getByText('Re-check needed — the bytes or the checker changed')).toBeVisible();
    await expect(canvas.getByText('Original not local — checked when it returns')).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Re-check' })).toBeEnabled();
  },
};

// Nothing was evaluated (the original is not local and nothing is stored):
// that is "Not checked", never an Unknown tier.
export const ProvenanceDeferredUnchecked: Story = {
  args: { photo: PHOTO },
  parameters: { provenance: { ...provenanceOf('unknown', [], { status: 'deferred' }), evidence: null } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const section = await canvas.findByTestId('inspector-provenance');
    await waitFor(() => expect(canvas.getByText('Original not local — checked when it returns')).toBeVisible());
    await expect(section).toHaveAttribute('data-tier', 'pending');
    await expect(canvas.getByTestId('inspector-provenance-tier')).toHaveTextContent('Not checked');
    await expect(canvas.getByText('Not checked yet')).toBeVisible();
    await expect(canvas.queryByText('Unknown is not a claim that a person made this image.')).toBeNull();
    await expect(canvas.getByRole('button', { name: 'Re-check' })).toBeEnabled();
  },
};

export const ProvenanceUnsupported: Story = {
  args: { photo: PHOTO },
  parameters: {
    provenance: { ...provenanceOf('unknown', []), evidence: null, unsupported: 'evidence format 2 is newer than this app' },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Newer evidence format — view only')).toBeVisible();
    await expect(canvas.getByTestId('inspector-provenance')).toHaveAttribute('data-tier', 'unsupported');
    await expect(canvas.getByTestId('inspector-provenance-tier')).toHaveTextContent('Newer format');
    // Re-check would replace forward-compatible evidence; it stays off.
    await expect(canvas.getByRole('button', { name: 'Re-check' })).toBeDisabled();
  },
};

// Variants (#496): the family over one original, the Promoted representative,
// and the shown variant's inert row. Promote moves the badge.
const DUPLICATE: PhotoRecord = {
  ...PHOTO,
  id: '01J8VARIANT0000000000000002',
  derivativeKey: 'b'.repeat(64),
  variantSourceId: PHOTO.id,
  importedAt: '2026-09-02T09:00:00.000Z',
  favorite: false,
  isOriginal: false,
};

export const VariantsFamily: Story = {
  args: { photo: PHOTO, onShowPhoto: fn() },
  parameters: { variants: { contentHash: PHOTO.contentHash, representativeId: DUPLICATE.id, variants: [PHOTO, DUPLICATE] } },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const section = await canvas.findByTestId('inspector-variants');
    await expect(section).toHaveAttribute('data-count', '2');
    await expect(canvas.getByTestId('inspector-variants-count')).toHaveTextContent('2 variants');
    const rows = canvas.getAllByTestId('inspector-variant');
    await expect(rows[0]).toHaveAttribute('data-representative', 'false');
    await expect(rows[1]).toHaveAttribute('data-representative', 'true');
    await expect(canvas.getByText('Representative')).toBeVisible();
    await expect(canvas.getByRole('button', { name: /^Show IMG_4021\.RAF, Imported/u })).toBeDisabled();
    await userEvent.click(canvas.getByRole('button', { name: /^Show .*Duplicate/u }));
    await expect(args.onShowPhoto).toHaveBeenCalledWith(DUPLICATE.id);
    await userEvent.click(canvas.getByRole('button', { name: /^Promote .* to representative$/u }));
    await expect(canvas.getAllByTestId('inspector-variant')[0]).toHaveAttribute('data-representative', 'true');
    await expect(canvas.getByRole('button', { name: 'Duplicate' })).toBeEnabled();
  },
};

// #498: the Histogram section over the stubbed bins — chart, clipping row
// (amber: highlights clip above 1%), and the honest source row.
export const Histogram: Story = {
  args: { photo: PHOTO },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 3, name: 'Histogram' })).toBeVisible();
    const section = canvasElement.querySelector('[data-testid="inspector-histogram"]');
    await waitFor(() => expect(section).toHaveAttribute('data-state', 'ready'));
    await expect(section).toHaveAttribute('data-digest', 'story001');
    await expect(canvas.getByRole('img', { name: 'Histogram of IMG_4021.RAF: red, green, blue and luminance' })).toBeVisible();
    await expect(canvas.getByText('Shadows 0.2% · Highlights 1.4%')).toBeVisible();
    await expect(canvas.getByText('Preview · sRGB · 2048×1365')).toBeVisible();
  },
};

export const HistogramUnavailable: Story = {
  args: { photo: PHOTO },
  parameters: { histogram: { state: 'unavailable', photoId: PHOTO.id, reason: 'missing' } satisfies HistogramPayload },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const section = canvasElement.querySelector('[data-testid="inspector-histogram"]');
    await waitFor(() => expect(section).toHaveAttribute('data-state', 'unavailable'));
    await expect(canvas.getByText('No preview in custody yet — repair pending')).toBeVisible();
    await expect(canvas.queryByRole('img', { name: /^Histogram of/u })).toBeNull();
  },
};

export const DeferredVariantPreviews: Story = {
  args: { photo: { ...PHOTO, previewFailure: 'deferred-original' } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Previews pending — original required on this device')).toBeVisible();
  },
};

export const LockedDuplicate: Story = {
  args: { photo: { ...PHOTO, locked: true, keyId: 7 } },
  play: async ({ canvasElement }) => {
    const duplicate = fn(window.overlook.variants.duplicate);
    Object.assign(window.overlook.variants, { duplicate });
    const section = within(await within(canvasElement).findByTestId('inspector-variants'));
    const action = section.getByRole('button', { name: 'Duplicate' });
    await expect(action).toBeDisabled();
    await expect(section.getByText('Locked — KEY #7 is not on this device')).toBeVisible();
    // Native activation verifies disabled semantics without a pointer helper rejecting the CSS guard.
    action.click();
    await expect(duplicate).not.toHaveBeenCalled();
    await expect(section.getByRole('button', { name: /Promote/u })).toBeEnabled();
  },
};
