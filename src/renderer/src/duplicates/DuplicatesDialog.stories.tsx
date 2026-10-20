import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import type { PhotoRecord } from '../../../shared/library/types.js';
import { DuplicatesDialog } from './DuplicatesDialog';

// Review Duplicates (#650): a group with a recompressed copy and a rotated
// copy of one photo, one member marked Original (no Trash button — its row
// says why, #482 / #1305), the moving and resolved states, and the empty and
// still-indexing states.

function photo(id: string, overrides: Partial<PhotoRecord> = {}): PhotoRecord {
  return {
    id,
    fileName: `${id}.jpg`,
    fileKind: 'jpeg',
    width: 1280,
    height: 853,
    bytes: 412_000,
    contentHash: `hash-${id}`,
    derivativeKey: `hash-${id}`,
    variantSourceId: null,
    assetOwnerId: null,
    camera: null,
    lens: null,
    iso: null,
    aperture: null,
    shutter: null,
    focalLength: null,
    takenAt: '2026-07-14T10:00:00.000Z',
    gpsLat: null,
    gpsLon: null,
    place: null,
    importedAt: '2026-07-20T17:00:00.000Z',
    importSource: 'story',
    favorite: false,
    isOriginal: false,
    keyId: 1,
    deletedAt: null,
    previewFailure: null,
    dimensionStatus: 'decoded',
    mediaInfo: null,
    syncState: 'local',
    ...overrides,
  } as PhotoRecord;
}

const REVIEW = {
  version: 'dhash-9x8-v1',
  threshold: 10,
  status: { total: 6, indexed: 6, deferred: 0, pending: 0 },
  groups: [
    {
      id: 'IMG_0001',
      photos: [
        photo('IMG_0001', { isOriginal: true, bytes: 2_400_000, width: 4032, height: 3024 }),
        photo('IMG_0001-web', { width: 1280, height: 960, bytes: 310_000 }),
        photo('IMG_0001-turned', { width: 3024, height: 4032, bytes: 2_100_000 }),
      ],
      pairs: [
        { left: 'IMG_0001', right: 'IMG_0001-web', distance: 1, rotation: 0 as const },
        { left: 'IMG_0001', right: 'IMG_0001-turned', distance: 4, rotation: 90 as const },
      ],
    },
  ],
};

const EMPTY = { ...REVIEW, groups: [], status: { total: 6, indexed: 6, deferred: 1, pending: 0 } };
const INDEXING = { ...REVIEW, groups: [], status: { total: 6, indexed: 2, deferred: 0, pending: 4 } };

type DuplicatesDialogApi = NonNullable<Parameters<typeof DuplicatesDialog>[0]['api']>;

const subscribe = () => () => undefined;
const remove = fn(() => Promise.resolve({ deleted: 1, protected: 0, missing: 0 }));

function apiFor(review: typeof REVIEW | typeof EMPTY): DuplicatesDialogApi {
  return {
    duplicates: { review: () => Promise.resolve(review), rescan: () => Promise.resolve(review.status), onChanged: subscribe },
    library: { delete: remove, onChanged: subscribe, onOriginalClassificationChanged: subscribe },
  } as unknown as DuplicatesDialogApi;
}

const meta: Meta<typeof DuplicatesDialog> = {
  title: 'Library/DuplicatesDialog',
  component: DuplicatesDialog,
  args: { open: true, onClose: fn(), dispatch: fn() },
};

export default meta;

type Story = StoryObj<typeof DuplicatesDialog>;

export const Group: Story = {
  render: (args) => <DuplicatesDialog {...args} api={apiFor(REVIEW)} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const body = await canvas.findByTestId('duplicates-dialog');
    await waitFor(() => expect(body).toHaveAttribute('data-state', 'ready'));
    await expect(body).toHaveAttribute('data-groups', '1');
    const group = canvas.getByRole('region', { name: 'Possible duplicates, 3 photos, 1 protected Original' });
    await expect(group).toHaveAttribute('data-count', '3');
    // Each row names its closest pair, so the original and its web copy share this evidence.
    const nearIdentical = canvas.getAllByText('Near-identical · 1 of 64 bits differ');
    await expect(nearIdentical).toHaveLength(2);
    for (const evidence of nearIdentical) await expect(evidence).toBeVisible();
    await expect(canvas.getByText('Very similar · rotated 90° · 4 of 64 bits differ')).toBeVisible();
  },
};

// The protected Original has no button: its reason is the row's own text.
export const ProtectedOriginal: Story = {
  render: (args) => <DuplicatesDialog {...args} api={apiFor(REVIEW)} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByTestId('duplicate-group');
    await expect(canvas.queryByRole('button', { name: 'Move to Trash: IMG_0001.jpg' })).toBeNull();
    await expect(canvas.getByText('Protected Original — kept')).toBeVisible();
    await expect(canvas.getByText('To remove it, use Shift+Delete in the library')).toBeVisible();
    await expect(canvasElement.querySelector('[title]')).toBeNull();
    await expect(canvas.getAllByRole('button', { name: /^Move to Trash: /u })).toHaveLength(2);
  },
};

// While a move runs, its row reads Moving… and every Trash button is
// unavailable but keeps focus.
export const Moving: Story = {
  render: (args) => {
    const api = apiFor(REVIEW);
    const pending = { ...api, library: { ...api.library, delete: () => new Promise(() => undefined) } } as DuplicatesDialogApi;
    return <DuplicatesDialog {...args} api={pending} />;
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByTestId('duplicate-group');
    const web = canvas.getByRole('button', { name: 'Move to Trash: IMG_0001-web.jpg' });
    web.focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(web).toHaveTextContent('Moving…'));
    await expect(web).toHaveFocus();
    for (const button of canvas.getAllByRole('button', { name: /^Move/u })) {
      await expect(button).toHaveAttribute('aria-disabled', 'true');
      await expect(button).toBeEnabled();
    }
  },
};

export const TrashRoutesThroughTheLibrary: Story = {
  render: (args) => <DuplicatesDialog {...args} api={apiFor(REVIEW)} />,
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    remove.mockClear();
    await canvas.findByTestId('duplicate-group');
    await userEvent.click(canvas.getByRole('button', { name: 'Move to Trash: IMG_0001-web.jpg' }));
    await expect(remove).toHaveBeenCalledWith({ photoIds: ['IMG_0001-web'] });
    await expect(args.dispatch).toHaveBeenCalledWith({
      type: 'toast/shown',
      // Silent: the dialog announces the move itself, once, after the reload (#1305).
      toast: { title: 'Moved IMG_0001-web.jpg to Trash', tone: 'neutral', announce: false },
    });
  },
};

export const Clean: Story = {
  render: (args) => <DuplicatesDialog {...args} api={apiFor(EMPTY)} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('No possible duplicates found.')).toBeVisible();
    await expect(canvas.getByText('1 photo has no preview to compare yet')).toBeVisible();
  },
};

export const StillIndexing: Story = {
  render: (args) => <DuplicatesDialog {...args} api={apiFor(INDEXING)} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const body = await canvas.findByTestId('duplicates-dialog');
    await waitFor(() => expect(body).toHaveAttribute('data-state', 'indexing'));
    await expect(canvas.getByText('Still comparing previews — nothing to review yet.')).toBeVisible();
    await expect(canvas.getByTestId('duplicates-progress')).toHaveTextContent('2 of 6 photos compared · 4 pending');
  },
};

// A library whose Trash really removes rows, so the review reloads the way
// main's does: a group left with one photo is no longer a group.
function liveApi(groups: typeof REVIEW.groups): DuplicatesDialogApi {
  let current = groups.map((group) => ({ ...group, photos: [...group.photos] }));
  const listeners = new Set<() => void>();
  const review = () => Promise.resolve({ ...REVIEW, groups: current });
  return {
    duplicates: {
      review,
      rescan: () => Promise.resolve(REVIEW.status),
      onChanged: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    library: {
      delete: ({ photoIds }: { photoIds: string[] }) => {
        current = current
          .map((group) => ({ ...group, photos: group.photos.filter((entry) => !photoIds.includes(entry.id)) }))
          .filter((group) => group.photos.length > 1);
        setTimeout(() => {
          for (const listener of listeners) listener();
        }, 20);
        return Promise.resolve({ deleted: 1, protected: 0, missing: 0 });
      },
      onChanged: subscribe,
      onOriginalClassificationChanged: subscribe,
    },
  } as unknown as DuplicatesDialogApi;
}

const TWO_GROUPS = [
  REVIEW.groups[0],
  {
    id: 'IMG_0200',
    photos: [photo('IMG_0200'), photo('IMG_0200-copy')],
    pairs: [{ left: 'IMG_0200', right: 'IMG_0200-copy', distance: 0, rotation: 0 as const }],
  },
] as typeof REVIEW.groups;

// A keyboard-only run to the end: after each move focus lands on the next
// candidate (never the dialog or <body>), and the count left is announced.
export const Resolved: Story = {
  render: (args) => <DuplicatesDialog {...args} api={liveApi(TWO_GROUPS)} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const announcer = within(document.body).getByTestId('screen-reader-announcer-polite');
    await canvas.findByRole('region', { name: 'Possible duplicates, 3 photos, 1 protected Original' });
    canvas.getByRole('button', { name: 'Move to Trash: IMG_0001-web.jpg' }).focus();

    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(canvas.getByRole('button', { name: 'Move to Trash: IMG_0001-turned.jpg' })).toHaveFocus());
    await expect(announcer).toHaveTextContent('Moved IMG_0001-web.jpg to Trash. 2 groups left.');

    // The last candidate leaves only the Original, so that group resolves and
    // focus moves to the group now in its place.
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(canvas.getByRole('button', { name: 'Move to Trash: IMG_0200.jpg' })).toHaveFocus());
    await expect(announcer).toHaveTextContent('Moved IMG_0001-turned.jpg to Trash. 1 group left.');

    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(canvas.getByRole('button', { name: 'Rescan' })).toHaveFocus());
    await expect(announcer).toHaveTextContent('Moved IMG_0200.jpg to Trash. No groups left.');
    await expect(canvas.getByText('No possible duplicates found.')).toBeVisible();
  },
};

// Originals pair only with each other (#482), so a group of them has no
// button at all — each row carries its own reason.
const ORIGINALS_ONLY = {
  ...REVIEW,
  groups: [
    {
      id: 'IMG_0300',
      photos: [photo('IMG_0300', { isOriginal: true }), photo('IMG_0300-edit', { isOriginal: true })],
      pairs: [{ left: 'IMG_0300', right: 'IMG_0300-edit', distance: 3, rotation: 0 as const }],
    },
  ],
} as typeof REVIEW;

export const OriginalsOnly: Story = {
  render: (args) => <DuplicatesDialog {...args} api={apiFor(ORIGINALS_ONLY)} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('region', { name: 'Possible duplicates, 2 photos, 2 protected Originals' });
    await expect(canvas.queryAllByRole('button', { name: /^Move/u })).toHaveLength(0);
    await expect(canvas.getAllByText('Protected Original — kept')).toHaveLength(2);
  },
};
