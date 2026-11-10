import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { useState, type ReactElement } from 'react';

import { DisclosureSettings } from './DisclosureSettings';
import { DisclosurePreview } from './DisclosurePreview';
import type { OverlookApi } from '../../../shared/ipc/api.js';
import type { DisclosurePreview as DisclosurePreviewData } from '../../../shared/ipc/disclosure-channels.js';
import {
  DEFAULT_DISCLOSURE_POLICY,
  PINNED_PRIVATE,
  type DisclosureDestination,
  type DisclosureField,
  type DisclosurePolicy,
} from '../../../shared/disclosure/policy.js';

// #509 exit criteria in the story lane: the Settings section lists every
// classifiable field with the §6 default, a change round-trips through the
// (stubbed) channel, the pinned-private set is shown read-only, and the
// pre-crossing preview names fields, values, destination and what blocks.

function installStub(): { readonly calls: { field: DisclosureField; class: string }[] } {
  const calls: { field: DisclosureField; class: string }[] = [];
  let policy: DisclosurePolicy = DEFAULT_DISCLOSURE_POLICY;
  const disclosureApi: OverlookApi['disclosure'] = {
    policy: () => Promise.resolve({ policy, pinned: [...PINNED_PRIVATE] }),
    setField: ({ field, class: cls }) => {
      calls.push({ field, class: cls });
      policy = { ...policy, fields: { ...policy.fields, [field]: cls } };
      return Promise.resolve({ policy });
    },
    overrides: () => Promise.resolve({ overrides: [] }),
    setOverride: () => Promise.resolve({ overrides: [] }),
    preview: () => Promise.reject(new Error('unused')),
  };
  (globalThis as { overlook?: Partial<OverlookApi> }).overlook = { disclosure: disclosureApi };
  return { calls };
}

const meta: Meta<typeof DisclosureSettings> = {
  title: 'Settings/Disclosure',
  component: DisclosureSettings,
  decorators: [
    (Story) => {
      installStub();
      return <Story />;
    },
  ],
};
export default meta;

type Story = StoryObj<typeof DisclosureSettings>;

export const Defaults: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(async () => {
      await expect(canvas.getByTestId('disclosure-field-location')).toHaveAttribute('data-class', 'private');
    });
    await expect(canvas.getByTestId('disclosure-field-title')).toHaveAttribute('data-class', 'shared');
    await expect(canvas.getByTestId('disclosure-pinned')).toHaveTextContent('key material');
    // Narrow title to private: the row reflects the stored answer.
    const titleGroup = canvas.getByRole('radiogroup', { name: 'Disclosure class for Title' });
    await userEvent.click(within(titleGroup).getByRole('radio', { name: 'Private' }));
    await waitFor(async () => {
      await expect(canvas.getByTestId('disclosure-field-title')).toHaveAttribute('data-class', 'private');
    });
  },
};

const PREVIEW: DisclosurePreviewData = {
  boundary: 'export',
  destination: 'shared',
  policyVersion: 1,
  photos: 3,
  fields: [
    { field: 'title', class: 'shared', disclosed: 2, withheld: 0, present: 2, sample: 'Harbour at dusk', widened: false },
    { field: 'captureTime', class: 'shared', disclosed: 3, withheld: 0, present: 3, sample: '2026-07-13T10:00:00.000Z', widened: false },
    { field: 'location', class: 'private', disclosed: 0, withheld: 1, present: 1, sample: '52.37, 4.9', widened: false },
  ],
  embedded: ['captureTime', 'location'],
  blocked: ['location'],
  retainedSidecars: 1,
};

function PreviewHarness(): ReactElement {
  const [destination, setDestination] = useState<DisclosureDestination>('shared');
  const [widen, setWiden] = useState<readonly DisclosureField[]>([]);
  const preview: DisclosurePreviewData = {
    ...PREVIEW,
    destination,
    blocked: widen.includes('location') ? [] : PREVIEW.blocked,
    fields: PREVIEW.fields.map((field) =>
      field.field === 'location' && widen.includes('location') ? { ...field, disclosed: 1, withheld: 0, widened: true } : field,
    ),
  };
  return (
    <div style={{ width: 380 }}>
      <DisclosurePreview
        preview={preview}
        destination={destination}
        onDestinationChange={setDestination}
        widen={widen}
        onWidenChange={setWiden}
      />
    </div>
  );
}

export const Preview: StoryObj = {
  render: () => <PreviewHarness />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByTestId('disclosure-row-title')).toHaveTextContent('Harbour at dusk');
    await expect(canvas.getByTestId('disclosure-row-location')).toHaveTextContent('Withheld');
    // Neutral class badges, each with its icon; Mixed would have none (#1308).
    for (const badge of canvasElement.querySelectorAll('.ovl-disclosure__field .ovl-badge')) {
      await expect(badge).toHaveClass('ovl-badge--neutral');
      await expect(badge.querySelector('svg')).not.toBeNull();
    }
    // Destination: a named recipient by default, each with its own hint.
    const destination = canvas.getByRole('radiogroup', { name: 'Destination' });
    await expect(within(destination).getByRole('radio', { name: 'Named recipient' })).toBeChecked();
    await expect(destination).toHaveAccessibleDescription(
      'A folder you choose, Apple Photos, or a keyed provider. Shared and Public fields cross.',
    );
    await userEvent.click(within(destination).getByRole('radio', { name: 'Public' }));
    await expect(destination).toHaveAccessibleDescription('Anyone with the link or address. Only Public fields cross.');
    await userEvent.click(within(destination).getByRole('radio', { name: 'Named recipient' }));
    // The blocked notice asks for a choice: no alert, a polite announcement.
    await expect(canvas.getByTestId('disclosure-blocked')).toBeVisible();
    await expect(canvas.queryByRole('alert')).toBeNull();
    const body = within(canvasElement.ownerDocument.body);
    await waitFor(() =>
      expect(body.getByTestId('screen-reader-announcer-polite')).toHaveTextContent(
        'The originals can’t leave while Precise location is withheld.',
      ),
    );
    await userEvent.click(within(canvas.getByTestId('disclosure-widen-location')).getByRole('checkbox'));
    await waitFor(async () => {
      await expect(canvas.queryByTestId('disclosure-blocked')).toBeNull();
    });
    await expect(canvas.getByTestId('disclosure-row-location')).toHaveAttribute('data-disclosed', '1');
    await expect(canvas.getByTestId('disclosure-sidecars')).toHaveTextContent('1 retained source sidecar travels unfiltered.');
  },
};
