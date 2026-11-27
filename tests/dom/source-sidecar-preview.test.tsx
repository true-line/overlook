import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'react-intl';

import { SourceSidecarsPreview } from '../../src/renderer/src/disclosure/SourceSidecarsPreview.js';
import { ExportDialog } from '../../src/renderer/src/export/ExportDialog.js';
import { AnnouncerProvider } from '../../src/renderer/src/components/LiveAnnouncer.js';
import type { SourceSidecarFinding } from '../../src/shared/disclosure/source-sidecars.js';
import type { DisclosurePreviewRequest } from '../../src/shared/ipc/disclosure-channels.js';

test('source preview names actual fields, values and uncertainty instead of claiming unfiltered travel', () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const sidecars: SourceSidecarFinding[] = [
    {
      photoId: 'P',
      fileName: 'GPS.xmp',
      status: 'inspected',
      fields: [{ field: 'location', values: ['GPSLatitude: 52.37N'] }],
      blocked: ['location'],
      refused: true,
    },
    { photoId: 'P', fileName: 'Recipe.aae', status: 'unknown', fields: [], blocked: ['location'], refused: true },
    { photoId: 'P', fileName: 'Broken.xmp', status: 'malformed', fields: [], blocked: [], refused: true },
    { photoId: 'P', fileName: 'Missing.xmp', status: 'unavailable', fields: [], blocked: [], refused: true },
    { photoId: 'P', fileName: 'Rating.xmp', status: 'unsupported', fields: [], blocked: [], refused: true, unclassified: ['xmp:Rating'] },
  ];
  const render = () =>
    act(() =>
      root.render(
        <IntlProvider locale="en">
          <SourceSidecarsPreview sidecars={sidecars} />
        </IntlProvider>,
      ),
    );
  try {
    render();
    const text = container.textContent ?? '';
    assert.match(text, /GPS.xmp.*Found: Precise location.*Withheld: Precise location/u);
    assert.match(text, /Recipe.aae.*Unknown format/u);
    assert.match(text, /Broken.xmp.*Malformed or oversized/u);
    assert.match(text, /Missing.xmp.*could not be read or verified/u);
    assert.match(text, /Rating.xmp.*Unclassified XMP properties: xmp:Rating/u);
    assert.ok(!text.includes('unfiltered'));
    assert.ok(!text.includes('52.37N'));
    const first = sidecars[0];
    assert.ok(first);
    first.blocked = [];
    first.refused = false;
    render();
    assert.ok(container.textContent?.includes('GPSLatitude: 52.37N'));
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

for (const status of ['malformed', 'unsupported'] as const)
  test(`${status} source sidecar blocks Export and switching to Metadata: None permits it`, async () => {
    const previous = window.overlook;
    let exports = 0;
    Object.defineProperty(window, 'overlook', {
      configurable: true,
      value: {
        disclosure: {
          preview: (request: DisclosurePreviewRequest) =>
            Promise.resolve({
              boundary: request.boundary,
              destination: request.destination,
              policyVersion: 1,
              photos: 1,
              fields: [],
              embedded: [],
              blocked: [],
              retainedSidecars: request.metadata === 'none' ? 0 : 1,
              sourceSidecars:
                request.metadata === 'none'
                  ? []
                  : [
                      {
                        photoId: 'P',
                        fileName: 'Broken.xmp',
                        status,
                        fields: [],
                        blocked: [],
                        refused: true,
                        unclassified: ['xmp:Rating'],
                      },
                    ],
            }),
        },
        export: {
          preflight: () => Promise.resolve({ edited: 0, losses: [] }),
          pickDestination: () => Promise.resolve({ path: '/chosen', authorization: '11111111-1111-4111-8111-111111111111' }),
          revokeDestination: () => Promise.resolve({ revoked: true }),
          run: () => {
            exports++;
            return Promise.resolve({
              exported: 1,
              failed: 0,
              cancelled: 0,
              failures: [],
              previewTranscodes: 0,
              bakedEdits: 0,
              editSidecars: 0,
            });
          },
          onProgress: () => () => undefined,
        },
      },
    });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const clickButton = async (text: string) => {
      const button = [...container.querySelectorAll('button')].find((entry) => entry.textContent?.includes(text));
      assert.ok(button);
      await act(async () => {
        button.click();
        await Promise.resolve();
      });
    };
    try {
      await act(async () => {
        root.render(
          <IntlProvider locale="en">
            <AnnouncerProvider>
              <ExportDialog open photoIds={['P']} onClose={() => undefined} />
            </AnnouncerProvider>
          </IntlProvider>,
        );
        await Promise.resolve();
      });
      await clickButton('Choose folder');
      assert.match(container.querySelector('[data-testid="export-reason"]')?.textContent ?? '', /source sidecar cannot be inspected/u);
      await clickButton('Export 1 photo');
      assert.equal(exports, 0);
      const none = container.querySelector<HTMLElement>('[role="radio"][aria-label="None"]');
      assert.ok(none);
      await act(async () => {
        none.click();
        await Promise.resolve();
      });
      await clickButton('Choose folder');
      await clickButton('Export 1 photo');
      assert.equal(exports, 1);
    } finally {
      act(() => root.unmount());
      container.remove();
      Object.defineProperty(window, 'overlook', { configurable: true, value: previous });
    }
  });
