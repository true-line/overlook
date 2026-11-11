import { useEffect } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import type { OverlookApi } from '../../../shared/ipc/api.js';
import type { SmartPredicate } from '../../../shared/library/smart-album.js';
import type { AlbumListing } from '../../../shared/library/types.js';
import { AppStateProvider, useAppDispatch } from '../state/app-state-context';
import { FacetBar } from './FacetBar';

// #514 / ADR-0030 §3: the facet bar's pickers, the union-within-a-facet
// interaction, the explicit composition control, and the two save paths.

const VALUES: Readonly<Record<string, readonly { value: string; count: number }[]>> = {
  camera: [
    { value: 'FUJIFILM X-T5', count: 214 },
    { value: 'SONY A7 IV', count: 88 },
    { value: 'RICOH GR III', count: 12 },
  ],
  fileType: [
    { value: 'jpeg', count: 300 },
    { value: 'raw', count: 14 },
  ],
  lens: [],
  location: [{ value: 'Lisbon', count: 40 }],
  tag: [{ value: 'trip', count: 9 }],
};

const facetValues = fn((request: { facet: string }) => Promise.resolve({ values: VALUES[request.facet] ?? [] }));
const setPredicate = fn((request: { albumId: string; predicate: SmartPredicate }) =>
  Promise.resolve({ album: { ...smartListing(), predicate: request.predicate } }),
);
const create = fn((request: { name: string; predicate?: SmartPredicate }) =>
  Promise.resolve({ album: { ...smartListing(), id: 'new', name: request.name, predicate: request.predicate ?? null } }),
);

function smartListing(): AlbumListing {
  return {
    id: 's1',
    name: 'Fuji RAW',
    count: 14,
    showInAllPhotos: true,
    visibleElsewhere: 0,
    visibleVia: [],
    kind: 'smart',
    parentId: null,
    inheritsVisibility: false,
    tags: [],
    predicate: { version: 1, composition: 'and', groups: [{ facet: 'camera', values: ['FUJIFILM X-T5'] }] },
    unsupported: null,
  };
}

function installStub(): void {
  const library = { onPendingCountChanged: () => () => undefined, facetValues } as unknown as OverlookApi['library'];
  const albums = { setPredicate, create } as unknown as OverlookApi['albums'];
  (globalThis as { overlook?: Partial<OverlookApi> }).overlook = { library, albums };
}

function Scenario({ smartAlbum }: { readonly smartAlbum: AlbumListing | null }) {
  const dispatch = useAppDispatch();
  useEffect(() => {
    if (smartAlbum?.predicate) dispatch({ type: 'smartAlbum/set', albumId: smartAlbum.id, predicate: smartAlbum.predicate });
  }, [dispatch, smartAlbum]);
  return <FacetBar smartAlbum={smartAlbum} albums={smartAlbum === null ? [] : [smartAlbum]} />;
}

function Bar(props: { readonly smartAlbum: AlbumListing | null }) {
  return (
    <AppStateProvider>
      <Scenario {...props} />
    </AppStateProvider>
  );
}

const meta: Meta<typeof Bar> = {
  title: 'App/Toolbar/FacetBar',
  component: Bar,
  parameters: { layout: 'padded' },
  decorators: [
    (Story) => {
      installStub();
      return <Story />;
    },
  ],
};

export default meta;
type Story = StoryObj<typeof Bar>;

export const LiveFilter: Story = {
  args: { smartAlbum: null },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('status')).toHaveTextContent('No facets');
    await expect(canvas.getByRole('button', { name: 'Save as Smart Album…' })).toBeDisabled();
    await userEvent.click(canvas.getByRole('button', { name: 'Camera' }));
    const panel = await canvas.findByRole('group', { name: 'Camera values' });
    await userEvent.click(await within(panel).findByRole('button', { name: 'FUJIFILM X-T5 214' }));
    await expect(within(panel).getByRole('button', { name: 'FUJIFILM X-T5 214' })).toHaveAttribute('aria-pressed', 'true');
    // A plain pick replaces; "Add to selection" widens the union.
    await userEvent.click(within(panel).getByRole('button', { name: 'SONY A7 IV 88' }));
    await expect(within(panel).getByRole('button', { name: 'FUJIFILM X-T5 214' })).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(within(panel).getByRole('checkbox', { name: 'Add to selection' }));
    await userEvent.click(within(panel).getByRole('button', { name: 'FUJIFILM X-T5 214' }));
    await expect(canvas.getByRole('button', { name: 'Camera · 2' })).toBeVisible();
    await expect(canvas.getByRole('status')).toHaveTextContent('1 facet');
    await userEvent.click(canvas.getByRole('button', { name: 'File type' }));
    await userEvent.click(
      await within(await canvas.findByRole('group', { name: 'File type values' })).findByRole('button', { name: 'RAW 14' }),
    );
    await expect(canvas.getByRole('status')).toHaveTextContent('2 facets · match all');
    await userEvent.click(canvas.getByRole('radio', { name: 'Match any' }));
    await expect(canvas.getByRole('status')).toHaveTextContent('2 facets · match any');
    await expect(canvas.getByRole('button', { name: 'Save as Smart Album…' })).toBeEnabled();
  },
};

export const Megapixels: Story = {
  args: { smartAlbum: null },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Megapixels' }));
    await userEvent.type(canvas.getByRole('spinbutton', { name: 'Minimum megapixels' }), '12');
    await userEvent.click(canvas.getByRole('button', { name: 'Apply' }));
    await expect(canvas.getByRole('button', { name: 'Megapixels · 1' })).toBeVisible();
    await expect(canvas.getByText('Photos with unknown dimensions never match a size range.')).toBeVisible();
  },
};

export const EditingSmartAlbum: Story = {
  args: { smartAlbum: smartListing() },
  loaders: [
    () => {
      setPredicate.mockClear();
      return Promise.resolve({});
    },
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByRole('status')).toHaveTextContent('1 facet · Editing Fuji RAW'));
    await expect(canvas.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    await userEvent.click(canvas.getByRole('button', { name: 'Favorite' }));
    await userEvent.click(within(canvas.getByRole('group', { name: 'Favorite values' })).getByRole('button', { name: 'Favorite' }));
    await expect(canvas.getByRole('button', { name: 'Save changes' })).toBeEnabled();
    await userEvent.click(canvas.getByRole('button', { name: 'Save changes' }));
    await expect(setPredicate).toHaveBeenCalledTimes(1);
    const request = setPredicate.mock.calls[0]?.[0];
    await expect(request?.albumId).toBe('s1');
    await expect(request?.predicate.groups.map((group) => group.facet)).toEqual(['camera', 'favorite']);
  },
};
