import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fireEvent, fn, userEvent, waitFor, within } from 'storybook/test';

import landscapePhoto from '../../../../tests/fixtures/photos/summer-landscape.jpg';
import portraitPhoto from '../../../../tests/fixtures/photos/street-city.jpg';
import { Lightbox, type LightboxProps } from './Lightbox';
import type { PhotoRecord } from '../../../shared/library/types.js';
import type { OverlookApi } from '../../../shared/ipc/api.js';
import type { EditHeadPayload } from '../../../shared/ipc/photo-edit-channels.js';
import type { PhotoCustodyStatus } from '../../../shared/backup/custody-status.js';

// #92 exit criteria: chrome hides after 2.2s idle and wakes on mousemove
// (200ms ease-out fades); RAW records carry the PREVIEW badge; the EXIF
// strip renders only what the file states.

const PHOTO: PhotoRecord = {
  id: '01J8SEEDPHOTO0001',
  fileName: 'IMG_4028.JPG',
  fileKind: 'jpeg',
  mediaInfo: null,
  width: 1280,
  height: 838,
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
  importedAt: '2026-07-01T00:00:00.000Z',
  importSource: 'seed',
  favorite: false,
  isOriginal: false,
  keyId: 1,
  deletedAt: null,
  previewFailure: null,
  dimensionStatus: 'verified',
  syncState: 'local',
  coverage: 'included',
  locked: false,
  title: null,
  description: null,
  tags: [],
  userTags: [],
  importedKeywords: [],
  suppressedKeywords: [],
  metadataVersion: 1,
};

type EphemeralStage = 'fetching' | 'verifying' | 'ready' | 'released' | 'error';

let backupStubCalls = { status: 0, prepare: 0 };

function installBackupStub(stage: EphemeralStage | null, custodyStatus?: PhotoCustodyStatus): void {
  backupStubCalls = { status: 0, prepare: 0 };
  (globalThis as { overlook?: Partial<OverlookApi> }).overlook = {
    backup: {
      ephemeralStatus: () => {
        backupStubCalls.status += 1;
        return Promise.resolve({ stage });
      },
      photoCustodyStatus: () =>
        Promise.resolve(
          custodyStatus ?? {
            state: stage === 'error' ? 'unavailable' : 'available',
            providerId: 'mock',
            providerLabel: 'Local mock',
            accountLabel: 'Mock account',
          },
        ),
      prepareEphemeral: () => {
        backupStubCalls.prepare += 1;
        return Promise.resolve({ custody: 'ephemeral' });
      },
      releaseEphemeral: () => Promise.resolve({ ok: true }),
      keepDownloaded: () => Promise.resolve({ ok: true }),
      onEphemeralState: () => () => undefined,
    } as unknown as OverlookApi['backup'],
  };
}

const meta: Meta<typeof Lightbox> = {
  title: 'App/Lightbox',
  component: Lightbox,
  args: {
    photo: PHOTO,
    imageSrc: landscapePhoto,
    onClose: fn(),
    onPrev: fn(),
    onNext: fn(),
    onToggleFavorite: fn(),
    inspectorOpen: false,
    onToggleInspector: fn(),
    onExport: fn(),
    onTransfer: fn(),
    onOffload: fn(),
    onRepairDimensions: fn(),
    onDelete: fn(),
  },
  decorators: [
    (Story, context) => {
      installBackupStub(
        (context.parameters['ephemeralStage'] as EphemeralStage | null | undefined) ?? null,
        context.parameters['custodyStatus'] as PhotoCustodyStatus | undefined,
      );
      const width = (context.parameters['lightboxWidth'] as number | undefined) ?? 960;
      const height = (context.parameters['lightboxHeight'] as number | undefined) ?? 640;
      return (
        <div style={{ position: 'relative', width: `min(${String(width)}px, 100vw)`, height: `${String(height)}px`, overflow: 'hidden' }}>
          <Story />
        </div>
      );
    },
  ],
};

export default meta;
type Story = StoryObj<typeof Lightbox>;

export const ChromeAutohide: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const surface = canvas.getByTestId('lightbox');
    // Chrome starts awake with the full control set and the EXIF strip.
    await expect(surface).toHaveAttribute('data-chrome', 'on');
    await expect(canvas.getByText('FUJIFILM X-T5 · ƒ/1.4 · 1/250S · ISO 200 · 35MM')).toBeVisible();
    // ...hides after the 2.2s idle window...
    await waitFor(() => expect(surface).toHaveAttribute('data-chrome', 'off'), { timeout: 4000 });
    // ...and wakes on mousemove.
    await userEvent.pointer({ target: surface, coords: { x: 200, y: 200 } });
    await expect(surface).toHaveAttribute('data-chrome', 'on');
  },
};

export const ClickImageHidesChromeAndKeyboardWakes: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const surface = canvas.getByTestId('lightbox');
    const viewport = canvas.getByTestId('lightbox-viewport');
    const image = canvas.getByRole('img', { name: PHOTO.fileName });
    await waitFor(() => expect(viewport).toHaveAttribute('data-load-state', 'decoded'));
    await userEvent.click(image);
    await expect(surface).toHaveAttribute('data-chrome', 'off');
    await expect(canvas.queryByText(/DOUBLE-CLICK TO FILL/u)).not.toBeInTheDocument();
    await userEvent.keyboard('x');
    await expect(surface).toHaveAttribute('data-chrome', 'on');
  },
};

// #269: an explicit ✕ closes back to the gallery — the back arrow reads as
// navigation and Esc is invisible; both still work alongside it.
export const CloseButton: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Close (Esc)' }));
    await expect(args.onClose).toHaveBeenCalled();
  },
};

export const ToolbarButtonsRemainInteractive: Story = {
  args: { photo: { ...PHOTO, syncState: 'synced' } },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Back to library (Esc)' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Favorite' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Export' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Transfer & Sync' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Offload original' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Inspector (I)' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Move to Trash' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Close (Esc)' }));

    await expect(args.onClose).toHaveBeenCalledTimes(2);
    await expect(args.onToggleFavorite).toHaveBeenCalledTimes(1);
    await expect(args.onExport).toHaveBeenCalledTimes(1);
    await expect(args.onTransfer).toHaveBeenCalledTimes(1);
    await expect(args.onOffload).toHaveBeenCalledTimes(1);
    await expect(args.onToggleInspector).toHaveBeenCalledTimes(1);
    await expect(args.onDelete).toHaveBeenCalledTimes(1);
  },
};

export const RawPreviewBadge: Story = {
  args: { photo: { ...PHOTO, fileKind: 'raw', fileName: 'IMG_4021.RAF' } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Preview')).toBeVisible();
    await expect(canvas.getByText(/IMG_4021\.RAF — Jun 12, 2026/u)).toBeVisible();
  },
};

export const PortraitFillZoomAndReset: Story = {
  args: {
    photo: { ...PHOTO, width: 960, height: 1280, fileName: 'PORTRAIT.JPG' },
    imageSrc: portraitPhoto,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const image = canvas.getByRole('img', { name: 'PORTRAIT.JPG' });
    const viewport = canvas.getByTestId('lightbox-viewport');
    await waitFor(() => expect(viewport).toHaveAttribute('data-load-state', 'decoded'));
    await expect(viewport).toHaveAttribute('data-mode', 'fit');
    await expect(viewport).toHaveAttribute('data-zoom', '1.000');
    await userEvent.dblClick(image);
    await waitFor(() => expect(viewport).toHaveAttribute('data-mode', 'fill'));
    await waitFor(() => expect(viewport).toHaveAttribute('data-zoom', '2.000'));
    await expect(canvas.getByTestId('lightbox')).toHaveAttribute('data-chrome', 'on');
    await userEvent.click(canvas.getByRole('button', { name: /^Fit image, currently/u }));
    await expect(viewport).toHaveAttribute('data-mode', 'fit');
    await expect(viewport).toHaveAttribute('data-zoom', '1.000');
  },
};

export const LandscapeFillCoversWidescreenAndPans: Story = {
  args: { photo: { ...PHOTO, width: 2100, height: 700, fileName: 'PANORAMA.JPG' } },
  parameters: { lightboxHeight: 540 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const image = canvas.getByRole('img', { name: 'PANORAMA.JPG' });
    const viewport = canvas.getByTestId('lightbox-viewport');
    await waitFor(() => expect(viewport).toHaveAttribute('data-load-state', 'decoded'));
    await userEvent.dblClick(image);
    await expect(viewport).toHaveAttribute('data-mode', 'fill');
    await waitFor(async () => {
      const viewportBounds = viewport.getBoundingClientRect();
      const imageBounds = image.getBoundingClientRect();
      await expect(imageBounds.width).toBeGreaterThan(viewportBounds.width + 1);
      await expect(Math.abs(imageBounds.height - viewportBounds.height)).toBeLessThanOrEqual(1);
    });
    await fireEvent.wheel(image, { deltaX: 5000 });
    await waitFor(() => expect(Number(viewport.dataset['panX'])).toBeLessThan(0));
    await expect(viewport).toHaveAttribute('data-pan-y', '0.0');
    await fireEvent.wheel(image, { deltaX: -10000 });
    await waitFor(() => expect(Number(viewport.dataset['panX'])).toBeGreaterThan(0));
  },
};

// #968: the canonical Fill case. A square has no long side, so it cannot be
// fitted by accident and still look right — in a 960x540 viewport it must match
// the width and overflow top and bottom. Bars on any side mean `min()` is back.
export const SquareFillCoversWidescreen: Story = {
  args: { photo: { ...PHOTO, width: 1280, height: 1280, fileName: 'SQUARE.JPG' } },
  parameters: { lightboxHeight: 540 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const image = canvas.getByRole('img', { name: 'SQUARE.JPG' });
    const viewport = canvas.getByTestId('lightbox-viewport');
    await waitFor(() => expect(viewport).toHaveAttribute('data-load-state', 'decoded'));
    await userEvent.dblClick(image);
    await expect(viewport).toHaveAttribute('data-mode', 'fill');
    // Poll the scale: until the ResizeObserver reports the viewport, Fill has a
    // zero box to work from and reads back 1.000 alongside an already-'fill'
    // mode. A bare assertion here caught that transient render and went red.
    await waitFor(() => expect(viewport).toHaveAttribute('data-zoom', '1.778'));
    await expect(viewport).toHaveAttribute('data-pan-x', '0.0');
    await expect(viewport).toHaveAttribute('data-pan-y', '0.0');
    await expectOneAxisOverflow(viewport, image, 'vertical');
  },
};

export const NavigationPreservesViewIntentAndCloseResets: Story = {
  render: () => <NavigationTransformHarness />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    let viewport = canvas.getByTestId('lightbox-viewport');
    const landscape = canvas.getByRole('img', { name: 'IMG_4028.JPG' });
    await waitFor(() => expect(landscape).toHaveProperty('naturalWidth', 1280));
    await userEvent.click(canvas.getByRole('button', { name: 'Zoom in (+)' }));
    await waitFor(() => expect(landscape.getBoundingClientRect().height).toBeGreaterThan(viewport.getBoundingClientRect().height));
    await fireEvent.wheel(landscape, { deltaY: 5000 });
    await waitFor(() => expect(Number(viewport.dataset['panY'])).toBeLessThan(0));
    await userEvent.click(canvas.getByRole('button', { name: 'Rotate clockwise (R)' }));
    await expect(viewport).toHaveAttribute('data-orientation-turns', '1');
    await waitFor(() => expect(Number(viewport.dataset['panY'])).toBeLessThan(0));

    await userEvent.click(canvas.getByRole('button', { name: 'Next (→)' }));
    await waitFor(() => expect(canvas.getByRole('img', { name: 'PORTRAIT.JPG' })).toBeVisible());
    viewport = canvas.getByTestId('lightbox-viewport');
    await expect(viewport).toHaveAttribute('data-mode', 'custom');
    await expect(viewport).toHaveAttribute('data-zoom', '1.250');
    await waitFor(() => expect(Number(viewport.dataset['panY'])).toBeLessThan(0));
    await expect(viewport).toHaveAttribute('data-orientation-turns', '0');

    await userEvent.click(canvas.getByRole('button', { name: 'Close (Esc)' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Reopen full view' }));
    viewport = canvas.getByTestId('lightbox-viewport');
    await expect(viewport).toHaveAttribute('data-mode', 'fit');
    await expect(viewport).toHaveAttribute('data-zoom', '1.000');
  },
};

export const FillNavigationRecomputesOneAxisOverflow: Story = {
  render: () => <FillNavigationHarness />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    let viewport = canvas.getByTestId('lightbox-viewport');
    let image = canvas.getByRole('img', { name: 'PORTRAIT.JPG' });
    await waitFor(() => expect(viewport).toHaveAttribute('data-load-state', 'decoded'));
    await userEvent.dblClick(image);
    await expect(viewport).toHaveAttribute('data-mode', 'fill');
    await expectOneAxisOverflow(viewport, image, 'vertical');

    await userEvent.click(canvas.getByRole('button', { name: 'Next (→)' }));
    await waitFor(() => expect(canvas.getByRole('img', { name: 'IMG_4028.JPG' })).toBeVisible());
    viewport = canvas.getByTestId('lightbox-viewport');
    image = canvas.getByRole('img', { name: 'IMG_4028.JPG' });
    await expect(viewport).toHaveAttribute('data-mode', 'fill');
    await expectOneAxisOverflow(viewport, image, 'horizontal');
  },
};

export const LegacyUnknownDimensionsRepairOnDecode: Story = {
  args: {
    photo: { ...PHOTO, width: 0, height: 0, fileName: 'LEGACY-ZERO.JPG' },
    imageSrc: portraitPhoto,
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const viewport = canvas.getByTestId('lightbox-viewport');
    await waitFor(() => expect(viewport).toHaveAttribute('data-image-width', '960'));
    await expect(viewport).toHaveAttribute('data-image-height', '1280');
    await waitFor(() => expect(canvas.getByRole('img', { name: 'LEGACY-ZERO.JPG' })).toBeVisible());
    await expect(args.onRepairDimensions).toHaveBeenCalledWith(960, 1280);
  },
};

export const UndecodablePreviewIsExplicit: Story = {
  args: {
    photo: { ...PHOTO, width: 0, height: 0, fileName: 'CORRUPT.JPG' },
    imageSrc: 'data:image/jpeg;base64,AAAA',
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByText('Preview unavailable')).toBeVisible());
    await expect(canvas.getByTestId('lightbox-viewport')).toHaveAttribute('data-load-state', 'error');
    await expect(canvas.getByTestId('lightbox-viewport')).toHaveAttribute('data-unavailable', 'true');
  },
};

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: () => resolvePromise?.() };
}

function DelayedDecodeHarness(args: LightboxProps): ReactElement {
  const rootRef = useRef<HTMLDivElement>(null);
  const gate = useMemo(() => deferred(), []);
  useLayoutEffect(() => {
    const root = rootRef.current;
    const image = rootRef.current?.querySelector('img');
    if (root === null || image === null || image === undefined) return;
    Object.defineProperty(image, 'decode', { configurable: true, value: () => gate.promise });
    const release = (): void => gate.resolve();
    root.addEventListener('overlook-release-decode', release);
    return () => root.removeEventListener('overlook-release-decode', release);
  }, [gate]);
  return (
    <div ref={rootRef} data-testid="delayed-decode-harness" style={{ display: 'contents' }}>
      <Lightbox {...args} />
    </div>
  );
}

export const DelayedDecodeShowsStableLoadingState: Story = {
  render: (args) => <DelayedDecodeHarness {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const viewport = canvas.getByTestId('lightbox-viewport');
    const image = canvas.getByRole('img', { name: PHOTO.fileName });
    await expect(viewport).toHaveAttribute('data-load-state', 'loading');
    await expect(image).not.toBeVisible();
    await waitFor(() => expect(canvas.getByText('Loading full-resolution image…')).toBeVisible());
    canvas.getByTestId('delayed-decode-harness').dispatchEvent(new Event('overlook-release-decode'));
    await waitFor(() => expect(viewport).toHaveAttribute('data-load-state', 'decoded'));
    await waitFor(() => expect(image).toBeVisible());
    await expect(canvas.queryByText('Loading full-resolution image…')).not.toBeInTheDocument();
  },
};

export const CorruptHeicFailureIsExplicit: Story = {
  args: {
    photo: { ...PHOTO, width: 0, height: 0, fileName: 'CORRUPT.HEIC', fileKind: 'heic', previewFailure: 'corrupt' },
    imageSrc: 'data:image/jpeg;base64,AAAA',
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByText('Preview unavailable — file is corrupt')).toBeVisible());
  },
};

export const KeyboardZoom: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const viewport = canvas.getByTestId('lightbox-viewport');
    const fitButton = canvas.getByRole('button', { name: /^Fit image, currently/u });
    await userEvent.click(fitButton);
    await userEvent.keyboard('+');
    await waitFor(() => expect(viewport).toHaveAttribute('data-mode', 'custom'));
    await waitFor(() => expect(fitButton).toHaveTextContent('125%'));
    await userEvent.keyboard('0');
    await waitFor(() => expect(fitButton).toHaveTextContent('100%'));
  },
};

export const KeyboardPanWhenZoomed: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const viewport = canvas.getByTestId('lightbox-viewport');
    await waitFor(() => expect(viewport).toHaveAttribute('data-load-state', 'decoded'));
    await userEvent.click(canvas.getByRole('button', { name: /^Fit image, currently/u }));
    await userEvent.keyboard('+');
    await expect(viewport).toHaveAttribute('data-mode', 'custom');

    await userEvent.keyboard('{ArrowRight}{ArrowDown}');
    await waitFor(() => expect(Number(viewport.dataset['panX'])).toBeLessThan(0));
    await waitFor(() => expect(Number(viewport.dataset['panY'])).toBeLessThan(0));

    await userEvent.keyboard('{ArrowLeft}{ArrowUp}');
    await waitFor(() => expect(viewport).toHaveAttribute('data-pan-x', '0.0'));
    await waitFor(() => expect(viewport).toHaveAttribute('data-pan-y', '0.0'));
  },
};

export const OrientationToolbar: Story = {
  args: {
    photo: { ...PHOTO, width: 960, height: 1280, fileName: 'PORTRAIT.JPG' },
    imageSrc: portraitPhoto,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const viewport = canvas.getByTestId('lightbox-viewport');
    const image = canvas.getByRole('img', { name: 'PORTRAIT.JPG' });
    const resetOrientation = canvas.getByRole('button', { name: 'Reset orientation (⇧R)' });
    await waitFor(() => expect(image).toHaveProperty('naturalWidth', 960));
    await expect(resetOrientation).toBeEnabled();

    await userEvent.click(canvas.getByRole('button', { name: 'Zoom in (+)' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Rotate clockwise (R)' }));
    await expect(viewport).toHaveAttribute('data-orientation-turns', '1');
    await expect(image.style.transform).toContain('rotate(90deg)');
    await userEvent.click(canvas.getByRole('button', { name: 'Flip horizontally (H)' }));
    await expect(viewport).toHaveAttribute('data-orientation-flipped', 'true');
    await userEvent.click(resetOrientation);
    await expect(viewport).toHaveAttribute('data-orientation-turns', '0');
    await expect(viewport).toHaveAttribute('data-orientation-flipped', 'false');
    await expect(viewport).toHaveAttribute('data-zoom', '1.250');

    await userEvent.keyboard('r');
    await userEvent.keyboard('{Alt>}h{/Alt}');
    await expect(viewport).toHaveAttribute('data-orientation-turns', '3');
    await expect(viewport).toHaveAttribute('data-orientation-flipped', 'true');
    await userEvent.keyboard('{Shift>}r{/Shift}');
    await expect(viewport).toHaveAttribute('data-orientation-turns', '0');
    await expect(viewport).toHaveAttribute('data-orientation-flipped', 'false');
  },
};

// #499: measured from the supplied 924×540 handoff reference at
// design/handoff/references/06-lightbox-default-contain.png. Geometry assertions
// make spacing/placement drift fail without relying on platform font rasterization.
export const HandoffTransformToolbar: Story = {
  ...OrientationToolbar,
  parameters: { lightboxWidth: 924, lightboxHeight: 540 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const viewport = canvas.getByTestId('lightbox-viewport');
    const image = canvas.getByRole('img', { name: 'PORTRAIT.JPG' });
    const orientation = canvas.getByRole('toolbar', { name: 'Image orientation controls' });
    const zoom = canvas.getByLabelText('Image zoom controls');
    const controls = within(orientation).getAllByRole('button');
    await waitFor(() => expect(image).toHaveProperty('naturalWidth', 960));

    await waitFor(() => expect(Math.round(orientation.getBoundingClientRect().top - viewport.getBoundingClientRect().top)).toBe(448));
    const viewportRect = viewport.getBoundingClientRect();
    const orientationRect = orientation.getBoundingClientRect();
    const zoomRect = zoom.getBoundingClientRect();
    await expect(Math.round(viewportRect.width)).toBe(924);
    await expect(Math.round(viewportRect.height)).toBe(540);
    await expect(
      Math.abs(orientationRect.left + orientationRect.width / 2 - (viewportRect.left + viewportRect.width / 2)),
    ).toBeLessThanOrEqual(1);
    await expect(Math.round(orientationRect.width)).toBe(189);
    await expect(Math.round(orientationRect.height)).toBe(34);
    await expect(Math.round(zoomRect.left - orientationRect.right)).toBe(11);
    for (const control of controls) {
      const rect = control.getBoundingClientRect();
      await expect(Math.round(rect.width)).toBe(28);
      await expect(Math.round(rect.height)).toBe(28);
    }
    await expect(getComputedStyle(orientation).borderRadius).toBe('6px');
    await expect(getComputedStyle(orientation).boxShadow).not.toBe('none');
  },
};

function DurableSyncPatchHarness(args: LightboxProps): ReactElement {
  const [syncState, setSyncState] = useState<PhotoRecord['syncState']>('local');
  return (
    <>
      <button onClick={() => setSyncState((current) => (current === 'local' ? 'syncing' : 'synced'))}>Advance sync state</button>
      <Lightbox {...args} photo={{ ...args.photo, syncState }} />
    </>
  );
}

export const DurableSyncPatchPreservesViewport: Story = {
  render: (args) => <DurableSyncPatchHarness {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const viewport = canvas.getByTestId('lightbox-viewport');
    await waitFor(() => expect(viewport).toHaveAttribute('data-load-state', 'decoded'));
    await userEvent.click(canvas.getByRole('button', { name: 'Rotate clockwise (R)' }));
    await expect(viewport).toHaveAttribute('data-orientation-turns', '1');

    await userEvent.click(canvas.getByRole('button', { name: 'Advance sync state' }));
    await expect(viewport).toHaveAttribute('data-orientation-turns', '1');
    await expect(viewport).toHaveAttribute('data-load-state', 'decoded');
    await userEvent.click(canvas.getByRole('button', { name: 'Advance sync state' }));
    await expect(viewport).toHaveAttribute('data-orientation-turns', '1');
    await expect(viewport).toHaveAttribute('data-load-state', 'decoded');
  },
};

export const NarrowOrientationToolbar: Story = {
  ...OrientationToolbar,
  parameters: { lightboxWidth: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const orientation = canvas.getByRole('toolbar', { name: 'Image orientation controls' });
    const zoom = canvas.getByLabelText('Image zoom controls');
    await expect(orientation).toBeVisible();
    await expect(zoom).toBeVisible();
    await waitFor(() => expect(zoom.getBoundingClientRect().bottom).toBeLessThanOrEqual(orientation.getBoundingClientRect().top));
  },
};

export const SyncedOriginalCanBeOffloaded: Story = {
  args: { photo: { ...PHOTO, syncState: 'synced' } },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Offload original' }));
    await expect(args.onOffload).toHaveBeenCalledTimes(1);
  },
};

export const OffloadedFetching: Story = {
  args: { photo: { ...PHOTO, syncState: 'offloaded' } },
  parameters: { ephemeralStage: 'fetching' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByText('Fetching original…')).toBeVisible());
    await expect(canvas.queryByRole('button', { name: 'Keep downloaded' })).not.toBeInTheDocument();
  },
};

export const OffloadedVerifying: Story = {
  args: { photo: { ...PHOTO, syncState: 'offloaded' } },
  parameters: { ephemeralStage: 'verifying' },
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(within(canvasElement).getByText('Verifying original…')).toBeVisible());
  },
};

export const OffloadedStreaming: Story = {
  args: { photo: { ...PHOTO, syncState: 'offloaded' } },
  parameters: { ephemeralStage: 'ready' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByText('Streaming original · re-offloads on close')).toBeVisible());
    await expect(canvas.getByRole('button', { name: 'Keep downloaded' })).toBeVisible();
    await expect(canvas.getByText('FUJIFILM X-T5 · ƒ/1.4 · 1/250S · ISO 200 · 35MM')).toBeVisible();
  },
};

export const OffloadedUnavailable: Story = {
  args: { photo: { ...PHOTO, syncState: 'offloaded' } },
  parameters: { ephemeralStage: 'error' },
  play: async ({ canvasElement }) => {
    await waitFor(() =>
      expect(
        within(canvasElement).getByText('Local mock unavailable — try again without changing the original’s recorded custody.', {
          selector: '.ovl-lightbox__custody .prose-note',
        }),
      ).toBeVisible(),
    );
  },
};

export const OffloadedWrongAccount: Story = {
  args: { photo: { ...PHOTO, syncState: 'offloaded' } },
  parameters: {
    ephemeralStage: 'error',
    custodyStatus: {
      state: 'wrong-account',
      providerId: 'google-drive',
      providerLabel: 'Google Drive',
      accountLabel: 'm.rivera@gmail.com',
    } satisfies PhotoCustodyStatus,
  },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByText(
        'Wrong Google Drive account — reconnect as m.rivera@gmail.com; this account cannot satisfy the recorded custody.',
        { selector: '.ovl-lightbox__custody .prose-note' },
      ),
    ).toBeVisible();
  },
};

export const OffloadedMissingOrCorrupt: Story = {
  args: { photo: { ...PHOTO, syncState: 'offloaded' } },
  parameters: {
    ephemeralStage: 'error',
    custodyStatus: {
      state: 'missing-corrupt',
      providerId: 'pcloud',
      providerLabel: 'pCloud',
      accountLabel: 'owner@pcloud.test',
    } satisfies PhotoCustodyStatus,
  },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByText(
        'Original missing or corrupt in pCloud — custody remains bound and recovery could not complete.',
        { selector: '.ovl-lightbox__custody .prose-note' },
      ),
    ).toBeVisible();
  },
};

export const BoundIntegrityError: Story = {
  args: { photo: { ...PHOTO, syncState: 'error' } },
  parameters: {
    ephemeralStage: 'error',
    custodyStatus: {
      state: 'missing-corrupt',
      providerId: 'pcloud',
      providerLabel: 'pCloud',
      accountLabel: 'owner@pcloud.test',
    } satisfies PhotoCustodyStatus,
  },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByText(
        'Original missing or corrupt in pCloud — custody remains bound and recovery could not complete.',
        { selector: '.ovl-lightbox__custody .prose-note' },
      ),
    ).toBeVisible();
    await waitFor(() => expect(backupStubCalls.prepare).toBe(1));
    await expect(within(canvasElement).queryByRole('button', { name: 'Keep downloaded' })).not.toBeInTheDocument();
  },
};

function OffloadTransitionHarness(args: LightboxProps) {
  const [offloading, setOffloading] = useState(false);
  return (
    <Lightbox
      {...args}
      photo={{ ...args.photo, syncState: offloading ? 'offloaded' : 'synced' }}
      suppressRehydrate={offloading}
      onOffload={() => setOffloading(true)}
    />
  );
}

function NavigationTransformHarness() {
  const [open, setOpen] = useState(true);
  const [index, setIndex] = useState(0);
  if (!open) return <button onClick={() => setOpen(true)}>Reopen full view</button>;
  const photos = [PHOTO, { ...PHOTO, id: '01J8SEEDPHOTO0002', fileName: 'PORTRAIT.JPG', width: 960, height: 1280 }];
  const photo = photos[index] ?? PHOTO;
  return (
    <Lightbox
      photo={photo}
      imageSrc={index === 0 ? landscapePhoto : portraitPhoto}
      onClose={() => setOpen(false)}
      onPrev={() => setIndex((current) => (current + photos.length - 1) % photos.length)}
      onNext={() => setIndex((current) => (current + 1) % photos.length)}
      onToggleFavorite={fn()}
      inspectorOpen={false}
      onToggleInspector={fn()}
      onExport={fn()}
      onTransfer={fn()}
      onOffload={fn()}
      onRepairDimensions={fn()}
      onDelete={fn()}
    />
  );
}

function FillNavigationHarness() {
  const [index, setIndex] = useState(0);
  const photos = [{ ...PHOTO, id: '01J8SEEDPHOTO0002', fileName: 'PORTRAIT.JPG', width: 960, height: 1280 }, PHOTO];
  const photo = photos[index] ?? PHOTO;
  return (
    <Lightbox
      photo={photo}
      imageSrc={index === 0 ? portraitPhoto : landscapePhoto}
      onClose={fn()}
      onPrev={() => setIndex((current) => (current + photos.length - 1) % photos.length)}
      onNext={() => setIndex((current) => (current + 1) % photos.length)}
      onToggleFavorite={fn()}
      inspectorOpen={false}
      onToggleInspector={fn()}
      onExport={fn()}
      onTransfer={fn()}
      onOffload={fn()}
      onRepairDimensions={fn()}
      onDelete={fn()}
    />
  );
}

async function expectOneAxisOverflow(viewport: HTMLElement, image: HTMLElement, axis: 'horizontal' | 'vertical'): Promise<void> {
  await waitFor(async () => {
    const viewportBounds = viewport.getBoundingClientRect();
    const imageBounds = image.getBoundingClientRect();
    const horizontal = imageBounds.width - viewportBounds.width;
    const vertical = imageBounds.height - viewportBounds.height;
    if (axis === 'horizontal') {
      await expect(horizontal).toBeGreaterThan(1);
      await expect(Math.abs(vertical)).toBeLessThanOrEqual(1);
    } else {
      await expect(vertical).toBeGreaterThan(1);
      await expect(Math.abs(horizontal)).toBeLessThanOrEqual(1);
    }
  });
}

export const OffloadSuppressionBlocksFetch: Story = {
  args: { photo: { ...PHOTO, syncState: 'synced' } },
  render: (args) => <OffloadTransitionHarness {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const originalImage = canvas.getByRole('img', { name: PHOTO.fileName });
    await userEvent.click(canvas.getByRole('button', { name: 'Offload original' }));
    await waitFor(() => expect(backupStubCalls.status).toBeGreaterThan(0));
    await expect(backupStubCalls.prepare).toBe(0);
    await expect(canvas.getByRole('img', { name: PHOTO.fileName })).toBe(originalImage);
  },
};

// #547 / ADR-0026 §7: under prefers-reduced-motion, animated GIF/WebP opens
// on the static poster and plays only on an intentional, always-visible
// action. The media query is forced through a scoped matchMedia patch so the
// story is deterministic regardless of the host OS setting.
let reducedMotionForced = false;
const originalMatchMedia = typeof window === 'undefined' ? undefined : window.matchMedia.bind(window);
if (originalMatchMedia !== undefined) {
  window.matchMedia = (query: string) => {
    if (reducedMotionForced && query.includes('prefers-reduced-motion')) {
      return {
        matches: true,
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      };
    }
    return originalMatchMedia(query);
  };
}

const ANIMATED_PHOTO: PhotoRecord = {
  ...PHOTO,
  id: '01J8SEEDPHOTO0002',
  fileName: 'party.gif',
  fileKind: 'gif',
  mediaInfo: { animated: true, frameCount: 3, loopCount: 0 },
};

export const AnimatedReducedMotionHoldsPoster: Story = {
  args: { photo: ANIMATED_PHOTO, imageSrc: portraitPhoto, posterSrc: landscapePhoto },
  decorators: [
    (Story) => {
      reducedMotionForced = true;
      return <Story />;
    },
  ],
  play: async ({ canvasElement }) => {
    try {
      const canvas = within(canvasElement);
      const image = (): HTMLImageElement => canvas.getByRole<HTMLImageElement>('img', { name: ANIMATED_PHOTO.fileName });
      await expect(image().src).toContain(landscapePhoto);
      const playButton = canvas.getByRole('button', { name: 'Play animation' });
      await expect(playButton).toHaveAttribute('aria-pressed', 'false');
      await userEvent.click(playButton);
      await expect(image().src).toContain(portraitPhoto);
      const stopButton = canvas.getByRole('button', { name: 'Show static poster' });
      await expect(stopButton).toHaveAttribute('aria-pressed', 'true');
      await userEvent.click(stopButton);
      await expect(image().src).toContain(landscapePhoto);
    } finally {
      reducedMotionForced = false;
    }
  },
};

export const AnimatedWithoutReducedMotionPlaysImmediately: Story = {
  args: { photo: ANIMATED_PHOTO, imageSrc: portraitPhoto, posterSrc: landscapePhoto },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const image = canvas.getByRole<HTMLImageElement>('img', { name: ANIMATED_PHOTO.fileName });
    await expect(image.src).toContain(portraitPhoto);
    await expect(canvas.queryByRole('button', { name: 'Play animation' })).not.toBeInTheDocument();
  },
};

// Persisted edits (#493): the viewport opens on the head's transform, the
// edit toolbar tracks dirtiness, and Crop opens the drawing surface.
const EDIT_HEAD: NonNullable<EditHeadPayload['head']> = {
  id: '01J8ED00000000000000000001',
  parentId: null,
  createdAt: '2026-09-01T10:00:00.000Z',
  operations: [{ type: 'rotate', version: 1, quarterTurns: 1 }],
  transform: { quarterTurns: 1, flipped: false, crop: null },
  unsupported: null,
};

function editStub(head: EditHeadPayload['head']): OverlookApi['edits'] {
  const payload: EditHeadPayload = { photoId: PHOTO.id, head, history: head === null ? [] : [{ ...head, current: true }] };
  const result = { ...payload, changed: true, derivatives: 'regenerated' as const, pendingCount: 1 };
  return {
    head: () => Promise.resolve(payload),
    save: () => Promise.resolve(result),
    reset: () => Promise.resolve(result),
    revert: () => Promise.resolve(result),
  };
}

export const PersistedRotation: Story = {
  args: { editApi: editStub(EDIT_HEAD) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const viewport = canvas.getByTestId('lightbox-viewport');
    await waitFor(() => expect(viewport).toHaveAttribute('data-orientation-turns', '1'));
    await expect(viewport).toHaveAttribute('data-edit-dirty', 'false');
    await expect(canvas.getByTestId('lightbox-edit-save')).toBeDisabled();
    await expect(canvas.getByTestId('lightbox-edit-reset')).toBeEnabled();
    // Turning again makes the draft dirty and arms Save.
    await userEvent.click(canvas.getByRole('button', { name: /^Rotate clockwise/u }));
    await expect(viewport).toHaveAttribute('data-orientation-turns', '2');
    await expect(viewport).toHaveAttribute('data-edit-dirty', 'true');
    await expect(canvas.getByTestId('lightbox-edit-save')).toBeEnabled();
  },
};

export const CropMode: Story = {
  args: { editApi: editStub(null) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const viewport = canvas.getByTestId('lightbox-viewport');
    await waitFor(() => expect(canvas.getByTestId('lightbox-edit-crop')).toBeEnabled());
    await userEvent.click(canvas.getByTestId('lightbox-edit-crop'));
    await expect(viewport).toHaveAttribute('data-edit-mode', 'crop');
    await expect(canvas.getByTestId('lightbox-crop')).toBeVisible();
    await expect(canvas.getByTestId('lightbox-crop-apply')).toBeVisible();
    await userEvent.keyboard('{Escape}');
    await expect(viewport).toHaveAttribute('data-edit-mode', 'view');
    await expect(canvas.queryByTestId('lightbox-crop')).toBeNull();
  },
};
