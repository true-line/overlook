import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within } from 'storybook/test';

import { RestoreLibraryCard } from './restore-library-card';

const meta: Meta<typeof RestoreLibraryCard> = {
  title: 'App/Restore library coverage',
  component: RestoreLibraryCard,
  args: {
    library: {
      libraryId: '01JZZZZZZZZZZZZZZZZZZZZZZZ',
      generation: 1,
      generatedAt: '2026-09-22T00:00:00.000Z',
      photos: 4,
      totalBytes: 8192,
      excludedCount: 2,
      excludedBytes: 4096,
      albums: 0,
      compatibility: 'compatible',
      validation: 'valid',
      fallbackGenerations: 0,
      resumable: false,
    },
    selected: true,
    onSelect: fn(),
  },
};
export default meta;
type Story = StoryObj<typeof RestoreLibraryCard>;

export const DeliberatelyExcluded: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByTestId('restore-excluded')).toHaveTextContent(
      '2 photos (4.1 kB) deliberately not held by this backup; kept as placeholders when restored.',
    );
    const select = canvas.getByRole('button', { name: /Select library/u });
    await expect(select).toBeEnabled();
    // The exclusion notice is visible inside the button, so it is part of the
    // accessible name rather than a separate description (WCAG 2.5.3).
    await expect(select).toHaveAccessibleName(
      /Select library 01JZZZZZZZZZZZZZZZZZZZZZZZ.*2 photos \(4\.1 kB\) deliberately not held by this backup; kept as placeholders when restored\./u,
    );
  },
};
