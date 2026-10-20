import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { ExportDialog } from './ExportDialog';
import type { OverlookApi } from '../../../shared/ipc/api.js';
import type { PhotoCustodyStatus } from '../../../shared/backup/custody-status.js';
import { DEFAULT_DISCLOSURE_FIELDS } from '../../../shared/disclosure/policy.js';

// #99 exit criteria: copy/pixel match to the mock, switch-off disables the
// button + shows the warning, and phases transition on engine events (the
// decorator installs a stub window.overlook.export that streams progress).

const IDS = ['A', 'B', 'C'];

interface PreflightStub {
  readonly edited: number;
  readonly losses: readonly { photoId: string; fileName: string; reason: string }[];
}

function installStub(custodyFailure?: PhotoCustodyStatus, preflight: PreflightStub = { edited: 0, losses: [] }): void {
  const exportApi: OverlookApi['export'] = {
    // Original only omits every edit by design, so main reports nothing lost for it.
    preflight: ({ mode }) => Promise.resolve({ edited: preflight.edited, losses: mode === 'original' ? [] : [...preflight.losses] }),
    pickDestination: () => Promise.resolve({ path: '/Users/demo/Exports', authorization: '00000000-0000-4000-8000-000000000001' }),
    revokeDestination: () => Promise.resolve({ revoked: true }),
    runAll: async () => {
      for (let done = 1; done <= IDS.length; done += 1) {
        await new Promise((resolve) => setTimeout(resolve, 40));
        listener?.({ done, total: IDS.length });
      }
      return { exported: IDS.length, failed: 0, cancelled: 0, previewTranscodes: 0, bakedEdits: 0, editSidecars: 0, failures: [] };
    },
    run: async () => {
      for (let done = 1; done <= IDS.length; done += 1) {
        await new Promise((resolve) => setTimeout(resolve, 40));
        listener?.({ done, total: IDS.length });
      }
      return custodyFailure === undefined
        ? { exported: IDS.length, failed: 0, cancelled: 0, previewTranscodes: 1, bakedEdits: 0, editSidecars: 0, failures: [] }
        : {
            exported: IDS.length - 1,
            failed: 1,
            cancelled: 0,
            previewTranscodes: 0,
            bakedEdits: 0,
            editSidecars: 0,
            failures: [{ photoId: IDS[0] ?? 'A', fileName: 'IMG_4021.RAF', reason: 'custody failed', custody: custodyFailure }],
          };
    },
    runBoard: () =>
      Promise.resolve({
        exported: true,
        cancelled: false,
        rendered: IDS.length,
        skipped: 0,
        skippedLocked: 0,
        skippedUnavailable: 0,
        fileName: 'Moodboard.png',
        path: '/Users/demo/Exports/Moodboard.png',
      }),
    cancel: () => Promise.resolve({}),
    onProgress: (next) => {
      listener = next;
      return () => {
        listener = null;
      };
    },
  };
  let listener: ((payload: { done: number; total: number }) => void) | null = null;
  const disclosureApi: OverlookApi['disclosure'] = {
    policy: () => Promise.resolve({ policy: { version: 1, fields: DEFAULT_DISCLOSURE_FIELDS }, pinned: [] }),
    setField: () => Promise.reject(new Error('unused')),
    overrides: () => Promise.resolve({ overrides: [] }),
    setOverride: () => Promise.reject(new Error('unused')),
    preview: (request) =>
      Promise.resolve({
        boundary: request.boundary,
        destination: request.destination,
        policyVersion: 1,
        photos: IDS.length,
        fields: [
          {
            field: 'title',
            class: 'shared',
            disclosed: request.destination === 'public' ? 0 : 2,
            withheld: request.destination === 'public' ? 2 : 0,
            present: 2,
            sample: 'Harbour at dusk',
            widened: false,
          },
          {
            field: 'captureTime',
            class: 'shared',
            disclosed: request.destination === 'public' ? 0 : 3,
            withheld: request.destination === 'public' ? 3 : 0,
            present: 3,
            sample: '2026-07-13T10:00:00.000Z',
            widened: false,
          },
          {
            field: 'location',
            class: 'private',
            disclosed: request.operation?.widen.includes('location') === true ? 1 : 0,
            withheld: request.operation?.widen.includes('location') === true ? 0 : 1,
            present: 1,
            sample: '52.37, 4.9',
            widened: request.operation?.widen.includes('location') === true,
          },
        ],
        embedded: request.payload === 'original' ? ['captureTime', 'location'] : [],
        // These stories exercise the export flow, not the gate (DisclosurePreview
        // stories do): only a public destination holds an original back.
        blocked: request.payload === 'original' && request.destination === 'public' ? ['captureTime'] : [],
        retainedSidecars: request.metadata === 'original' ? 1 : 0,
      }),
  };
  (globalThis as { overlook?: Partial<OverlookApi> }).overlook = { export: exportApi, disclosure: disclosureApi };
}

const meta: Meta<typeof ExportDialog> = {
  title: 'App/ExportDialog',
  component: ExportDialog,
  args: { open: true, photoIds: IDS, onClose: fn() },
  decorators: [
    (Story, context) => {
      installStub(
        context.parameters['custodyFailure'] as PhotoCustodyStatus | undefined,
        context.parameters['preflight'] as PreflightStub | undefined,
      );
      return <Story />;
    },
  ],
};

export default meta;
type Story = StoryObj<typeof ExportDialog>;

export const Options: Story = {
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await expect(body.getByText('3 photos selected')).toBeVisible();
    await expect(body.getByText('Files are stored encrypted. Turn this on to write plain, openable files to disk.')).toBeVisible();
    // Decrypt ON by default; Export disabled only by the missing destination.
    await expect(body.getByRole('button', { name: /Export 3 photos/u })).toBeDisabled();
    await userEvent.click(body.getByRole('button', { name: /Choose folder/u }));
    await expect(body.getByRole('button', { name: /Export 3 photos/u })).toBeEnabled();
    await expect(body.getByText('/Users/demo/Exports')).toBeVisible();
    await expect(body.getByRole('button', { name: 'Copy export destination' })).toBeVisible();
    await userEvent.click(body.getByRole('radio', { name: 'Edits' }));
    await expect(body.getByText('Write title, description, and effective tags to a new XMP sidecar.')).toBeVisible();
    await userEvent.click(body.getByRole('radio', { name: 'None' }));
    await expect(body.getByText('Write no metadata sidecars.')).toBeVisible();
    // Switch OFF: the button disables and the verbatim warning appears.
    await userEvent.click(body.getByRole('switch', { name: 'Decrypt originals' }));
    await expect(body.getByRole('button', { name: /Export 3 photos/u })).toBeDisabled();
    await expect(body.getByRole('alert')).toHaveTextContent("Without decryption, exported files can't be opened outside Overlook.");
    await userEvent.click(body.getByRole('switch', { name: 'Decrypt originals' }));
    await expect(body.queryByRole('alert')).toBeNull();
  },
};

export const PhasesOnEngineEvents: Story = {
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(body.getByRole('button', { name: /Choose folder/u }));
    await userEvent.click(body.getByRole('button', { name: /Export 3 photos/u }));
    // Running: the single cyan bar with the decrypt label, fed by events…
    await expect(body.getByText('Decrypting & writing files')).toBeVisible();
    // …then done on the engine's resolution, with the preview-capped note.
    await waitFor(
      () => expect(body.getByText(/3 photos exported and decrypted\. 1 from RAW previews \(preview resolution\)\./u)).toBeVisible(),
      {
        timeout: 3000,
      },
    );
    await expect(body.getByRole('button', { name: 'Done' })).toBeVisible();
  },
};

export const AllUnencrypted: Story = {
  args: { allPhotos: true },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await expect(body.getByText('Every photo in this library')).toBeVisible();
    await expect(body.getByText('Unencrypted originals')).toBeVisible();
    await expect(body.queryByRole('switch', { name: 'Decrypt originals' })).toBeNull();
    // #497: Export all declares its payload mode like a selection does.
    await expect(body.getByRole('radiogroup', { name: 'Edits' })).toBeVisible();
    await userEvent.click(body.getByRole('button', { name: /Choose folder/u }));
    await expect(body.getByRole('button', { name: 'Export all photos' })).toBeEnabled();
  },
};

export const ProviderRequiredFailure: Story = {
  parameters: {
    custodyFailure: {
      state: 'provider-required',
      providerId: 'google-drive',
      providerLabel: 'Google Drive',
      accountLabel: 'm.rivera@gmail.com',
    } satisfies PhotoCustodyStatus,
  },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(body.getByRole('button', { name: /Choose folder/u }));
    await userEvent.click(body.getByRole('button', { name: /Export 3 photos/u }));
    await expect(await body.findByText(/2 exported · 1 failed/u)).toBeVisible();
    await userEvent.click(body.getByText('View item failures'));
    await expect(
      body.getByText(/IMG_4021\.RAF: Google Drive required — reconnect as m\.rivera@gmail\.com to recover this original\./u, {
        selector: '.ovl-copyable-value__text',
      }),
    ).toBeVisible();
  },
};

// #497 (ADR-0031 §6) / #1307: the preflight names an edit the mode can't
// carry. Export stays unavailable, with its reason under the footer, until
// the user confirms exporting without it or picks another mode.
export const EditLossReport: Story = {
  parameters: {
    preflight: {
      edited: 2,
      losses: [{ photoId: 'A', fileName: 'IMG_4021.RAF', reason: 'tone-curve v2' }],
    } satisfies PreflightStub,
  },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(body.getByRole('button', { name: /Choose folder/u }));
    const losses = await body.findByTestId('export-edits-losses');
    await expect(losses).toHaveTextContent('1 edit can’t travel in this mode:');
    await expect(losses).toHaveTextContent('IMG_4021.RAF: tone-curve v2');
    // A consequence, not an error: no alert, a polite announcement instead.
    await expect(body.queryByRole('alert')).toBeNull();
    await waitFor(() =>
      expect(body.getByTestId('screen-reader-announcer-polite')).toHaveTextContent(
        '1 edit can’t travel in this mode. Confirm to export without it, or choose another mode.',
      ),
    );
    const exportButton = body.getByRole('button', { name: /Export 3 photos/u });
    await expect(exportButton).toBeEnabled();
    await expect(exportButton).toHaveAttribute('aria-disabled', 'true');
    await expect(exportButton).toHaveAccessibleDescription('Confirm the edits that won’t be exported, or choose another mode.');
    await expect(body.getByTestId('export-reason')).toBeVisible();
    await userEvent.click(body.getByRole('checkbox', { name: 'Export without this edit' }));
    await expect(exportButton).not.toHaveAttribute('aria-disabled');
    await expect(body.queryByTestId('export-reason')).toBeNull();
    // Another mode is another loss list: the confirmation resets.
    await userEvent.click(body.getByRole('radio', { name: 'Bake' }));
    await userEvent.click(body.getByRole('radio', { name: 'Original + XMP' }));
    await expect(await body.findByRole('checkbox', { name: 'Export without this edit' })).not.toBeChecked();
    await expect(exportButton).toHaveAttribute('aria-disabled', 'true');
    // Original only omits every edit by design: a statement, not a loss to confirm.
    await userEvent.click(body.getByRole('radio', { name: 'Original only' }));
    await expect(await body.findByTestId('export-edits-omitted')).toHaveTextContent(
      '2 photos have presentation edits that will not be exported.',
    );
    await expect(body.queryByTestId('export-edits-losses')).toBeNull();
    await expect(exportButton).not.toHaveAttribute('aria-disabled');
    // Bake shows its explicit quality.
    await userEvent.click(body.getByRole('radio', { name: 'Bake' }));
    await expect(body.getByRole('radiogroup', { name: 'JPEG quality' })).toBeVisible();
  },
};

// The loss list shows five, then how many more (#1307).
export const ManyEditLosses: Story = {
  parameters: {
    preflight: {
      edited: 8,
      losses: Array.from({ length: 8 }, (_, index) => ({
        photoId: `P${String(index)}`,
        fileName: `IMG_40${String(20 + index)}.RAF`,
        reason: 'tone-curve v2',
      })),
    } satisfies PreflightStub,
  },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    const losses = await body.findByTestId('export-edits-losses');
    await expect(losses).toHaveTextContent('8 edits can’t travel in this mode:');
    await expect(within(losses).getAllByRole('listitem')).toHaveLength(6);
    await expect(within(losses).getByText('and 3 more')).toBeVisible();
    await expect(body.getByRole('checkbox', { name: 'Export without these 8 edits' })).not.toBeChecked();
  },
};

// A Public destination withholds a field the originals carry: Export names
// the way out instead of greying without a word (#1307).
export const BlockedByDisclosure: Story = {
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(body.getByRole('button', { name: /Choose folder/u }));
    await userEvent.click(await body.findByRole('radio', { name: 'Public' }));
    const exportButton = body.getByRole('button', { name: /Export 3 photos/u });
    await waitFor(() => expect(exportButton).toHaveAttribute('aria-disabled', 'true'));
    await expect(body.getByTestId('export-reason')).toHaveTextContent('Include the withheld field, or export Baked.');
    await expect(exportButton).toHaveAccessibleDescription('Include the withheld field, or export Baked.');
    await userEvent.click(body.getByRole('radio', { name: 'Bake' }));
    await waitFor(() => expect(exportButton).not.toHaveAttribute('aria-disabled'));
  },
};
