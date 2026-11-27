import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'react-intl';

import { AnnouncerProvider } from '../../src/renderer/src/components/LiveAnnouncer.js';
import { ExportDialog } from '../../src/renderer/src/export/ExportDialog.js';
import type { DisclosurePreviewRequest } from '../../src/shared/ipc/disclosure-channels.js';
import type { ExportDisclosureIntentWire } from '../../src/shared/ipc/export-channels.js';

for (const photos of [false, true]) {
  test(`${photos ? 'PhotoKit' : 'folder'} export requests consent on Export, respects Cancel, and sends only the issued token`, async () => {
    const previous = window.overlook;
    const previews: DisclosurePreviewRequest[] = [];
    const runs: { disclosure: ExportDisclosureIntentWire }[] = [];
    let confirmed = false;
    const consent = '11111111-1111-4111-8111-111111111111';
    const result = { exported: 1, failed: 0, cancelled: 0, failures: [], previewTranscodes: 0, bakedEdits: 0, editSidecars: 0 };
    const exportRun = (request: { disclosure: ExportDisclosureIntentWire }) => {
      runs.push(request);
      return Promise.resolve(result);
    };
    Object.defineProperty(window, 'overlook', {
      configurable: true,
      value: {
        disclosure: {
          preview: (request: DisclosurePreviewRequest) => {
            previews.push(request);
            return Promise.resolve({
              boundary: request.boundary,
              destination: request.destination,
              policyVersion: 1,
              photos: 1,
              fields: [],
              embedded: ['location'],
              blocked: request.operation?.widen.includes('location') ? [] : ['location'],
              retainedSidecars: 0,
              ...(request.confirmWidening && confirmed ? { consent } : {}),
            });
          },
        },
        export: {
          preflight: () => Promise.resolve({ edited: 0, losses: [] }),
          pickDestination: () => Promise.resolve({ path: '/chosen', authorization: consent }),
          revokeDestination: () => Promise.resolve({ revoked: true }),
          run: exportRun,
          onProgress: () => () => undefined,
        },
        photoKit: { export: exportRun, onProgress: () => () => undefined },
      },
    });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const click = async (selector: string) => {
      const element = container.querySelector<HTMLElement>(selector);
      assert.ok(element, selector);
      await act(async () => {
        element.click();
        await Promise.resolve();
      });
    };
    const clickButton = async (text: string) => {
      const button = [...container.querySelectorAll('button')].find((element) => element.textContent?.includes(text));
      assert.ok(button, text);
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
              <ExportDialog open photoIds={['P1']} onClose={() => undefined} />
            </AnnouncerProvider>
          </IntlProvider>,
        );
        await Promise.resolve();
      });
      if (photos) await click('[role="radio"][aria-label="Apple Photos"]');
      await click('[data-testid="disclosure-widen-location"] input');
      if (!photos) await clickButton('Choose folder');
      assert.equal(previews.filter((request) => request.confirmWidening).length, 0);
      await clickButton('Export 1 photo');
      assert.equal(runs.length, 0, 'Cancel cannot start an export');
      assert.equal(previews.filter((request) => request.confirmWidening).length, 1);
      confirmed = true;
      await clickButton('Export 1 photo');
      assert.equal(runs.length, 1);
      assert.deepEqual(runs[0]?.disclosure, { destination: 'shared', operation: { narrow: [], widen: [] }, consent });
      assert.deepEqual(previews.find((request) => request.confirmWidening)?.operation?.widen, ['location']);
    } finally {
      act(() => root.unmount());
      container.remove();
      Object.defineProperty(window, 'overlook', { configurable: true, value: previous });
    }
  });
}
