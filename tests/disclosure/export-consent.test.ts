import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createActivityFacade } from '../../src/main/activity/activity-publication.js';
import { ExportDestinationAuthority } from '../../src/main/export/export-destination-authority.js';
import { registerExportHandlersWith } from '../../src/main/export/export-ipc.js';
import type { ExportFacade } from '../../src/main/ipc.js';
import { channels } from '../../src/shared/ipc/channels.js';
import type { ExportDisclosureIntentWire } from '../../src/shared/ipc/export-channels.js';
import { wrapHandler } from '../../src/shared/ipc/registry.js';
import { consentFixture } from './consent-fixture.js';

const FAILED = { __overlookIpcFailure: true, error: { code: 'IPC_HANDLER_FAILED' } };
const RESULT = { exported: 1, failed: 0, cancelled: 0, previewTranscodes: 0, bakedEdits: 0, editSidecars: 0, failures: [] };
type TestEvent = { sender: { id: number } };
type Handlers = Map<string, (event: TestEvent, request: unknown) => unknown>;

function stubFacade(overrides: Partial<ExportFacade>): ExportFacade {
  return {
    run: () => Promise.resolve(RESULT),
    runAll: () => Promise.resolve(RESULT),
    preflight: () => Promise.resolve({ edited: 0, losses: [] }),
    runBoard: () =>
      Promise.resolve({
        exported: false,
        cancelled: true,
        rendered: 0,
        skipped: 0,
        skippedLocked: 0,
        skippedUnavailable: 0,
        fileName: null,
        path: null,
      }),
    cancel: () => undefined,
    pickDestination: () => Promise.resolve('/chosen'),
    ...overrides,
  };
}

function invokeExport(handlers: Handlers, channel: string, request: unknown): Promise<unknown> {
  const handler = handlers.get(channel);
  assert.ok(handler);
  return Promise.resolve(handler({ sender: { id: 7 } }, request));
}

describe('filesystem export consent adapters (#1141)', () => {
  for (const all of [false, true]) {
    test(`${all ? 'Export all' : 'selected export'} without widening remains token-free`, async () => {
      const handlers: Handlers = new Map();
      let calls = 0;
      const run = () => {
        calls++;
        return Promise.resolve(RESULT);
      };
      const facade = stubFacade({ run, runAll: run });
      registerExportHandlersWith(
        () => facade,
        undefined,
        new ExportDestinationAuthority(),
        undefined,
        {
          handle: (channel, handler) => {
            handlers.set(channel, handler);
          },
        },
        wrapHandler,
      );
      const options = { ...(all ? {} : { photoIds: ['P1'] }), mode: 'baked' };
      const picked = channels.exportPickDestination.response.parse(
        await invokeExport(handlers, channels.exportPickDestination.name, {
          intent: { operation: all ? 'all' : 'selected', ...options },
        }),
      );
      assert.ok(picked.authorization);
      assert.deepEqual(
        await invokeExport(handlers, all ? channels.exportRunAll.name : channels.exportRun.name, {
          ...options,
          authorization: picked.authorization,
        }),
        RESULT,
      );
      assert.equal(calls, 1);
    });

    test(`${all ? 'Export all' : 'selected export'} rejects raw intent, permits one use, rejects replay and concurrent reuse`, async (t) => {
      const f = consentFixture(t);
      const handlers = new Map<string, (event: TestEvent, request: unknown) => unknown>();
      const activity = createActivityFacade(f.db, () => undefined);
      const received: { ids: readonly string[]; disclosure: ExportDisclosureIntentWire | undefined }[] = [];
      let finish!: () => void;
      const facade = stubFacade({
        run: (
          ids: readonly string[],
          _path: string,
          _format: unknown,
          _metadata: unknown,
          _edits: unknown,
          disclosure?: ExportDisclosureIntentWire,
        ) => {
          received.push({ ids, disclosure });
          return new Promise<typeof RESULT>((resolve) => {
            finish = () => resolve(RESULT);
          });
        },
        runAll: () => {
          throw new Error('Widened Export all must use its consent-bound selection');
        },
        pickDestination: () => Promise.resolve('/chosen'),
      });
      const errors: unknown[] = [];
      registerExportHandlersWith(
        () => facade,
        () => activity,
        new ExportDestinationAuthority(),
        f.authority,
        {
          handle: (channel, handler) => {
            handlers.set(channel, handler);
          },
        },
        (channel, handler) => wrapHandler(channel, handler, { reportError: ({ error }) => errors.push(error) }),
      );
      const invoke = (channel: string, request: unknown) => invokeExport(handlers, channel, request);
      const wire = f.wire();
      const intent = all
        ? { operation: 'all', mode: 'original', disclosure: wire }
        : { operation: 'selected', photoIds: ['P1'], mode: 'original', disclosure: wire };
      const picked = channels.exportPickDestination.response.parse(await invoke(channels.exportPickDestination.name, { intent }));
      assert.ok(picked.authorization);
      const channel = all ? channels.exportRunAll.name : channels.exportRun.name;
      const input = { ...(all ? {} : { photoIds: ['P1'] }), mode: 'original', authorization: picked.authorization };
      assert.deepEqual(
        await invoke(channel, { ...input, disclosure: { ...wire, operation: { narrow: [], widen: ['location'] } } }),
        FAILED,
      );
      assert.match(String(errors[0]), /location/u);
      assert.equal(received.length, 0);
      const preview = await f.authority.preview({ ...f.request(), ...(all ? { photoIds: undefined } : {}), confirmWidening: true });
      assert.ok(preview.consent);
      const request = { ...input, disclosure: f.wire(preview.consent) };
      const first = invoke(channel, request);
      assert.equal(received.length, 1);
      assert.deepEqual(received[0]?.ids, ['P1']);
      assert.deepEqual(received[0]?.disclosure?.operation.widen, ['location']);
      assert.deepEqual(await invoke(channel, request), FAILED);
      finish();
      assert.deepEqual(await first, RESULT);
      assert.deepEqual(await invoke(channel, request), FAILED);
      assert.equal(received.length, 1);
      const events = activity.page(10).events;
      assert.equal(events[0]?.payload['disclosureWidened'], 'location');
      assert.ok(!JSON.stringify(events).includes(preview.consent));
      assert.ok(!JSON.stringify(events).includes('52.37'));
    });

    for (const change of [
      'photo',
      'destination',
      'boundary',
      'mode',
      'metadata',
      'narrow',
      'widen',
      'policy',
      'override',
      'value',
      'lock',
      'library',
      'expiry',
      'selection',
    ] as const) {
      test(`${all ? 'Export all' : 'selected export'} refuses ${change} mismatch/invalidation`, async (t) => {
        const f = consentFixture(t);
        const handlers = new Map<string, (event: TestEvent, request: unknown) => unknown>();
        let calls = 0;
        const facade = stubFacade({
          run: () => {
            calls++;
            return Promise.resolve(RESULT);
          },
          runAll: () => {
            calls++;
            return Promise.resolve(RESULT);
          },
          pickDestination: () => Promise.resolve('/chosen'),
        });
        registerExportHandlersWith(
          () => facade,
          undefined,
          new ExportDestinationAuthority(),
          f.authority,
          {
            handle: (channel, handler) => {
              handlers.set(channel, handler);
            },
          },
          wrapHandler,
        );
        const preview = await f.authority.preview({
          ...f.request(change === 'boundary' ? 'photo-kit' : 'export'),
          ...(all ? { photoIds: undefined } : {}),
          confirmWidening: true,
        });
        const input = {
          ...(all ? {} : { photoIds: ['P1'] }),
          mode: 'original',
          metadata: 'original',
          authorization: '11111111-1111-4111-8111-111111111111',
          disclosure: f.wire(preview.consent),
        };
        switch (change) {
          case 'photo':
            if (all) f.setIds(['P2']);
            else input.photoIds = ['P2'];
            break;
          case 'destination':
            input.disclosure.destination = 'public';
            break;
          case 'mode':
            input.mode = 'baked';
            break;
          case 'metadata':
            input.metadata = 'none';
            break;
          case 'narrow':
            input.disclosure.operation.narrow = ['camera'];
            break;
          case 'widen':
            input.disclosure.operation.widen = ['camera'];
            break;
          case 'policy':
            f.service.setField('title', 'private');
            break;
          case 'override':
            f.service.setOverride('photo', 'P1', 'title', 'private');
            break;
          case 'value':
            f.db.prepare('UPDATE photos SET gps_lat = 1 WHERE id = ?').run('P1');
            break;
          case 'lock':
            f.state.epoch += 2;
            break;
          case 'library':
            f.state.library = 'other';
            break;
          case 'expiry':
            f.state.now += 5 * 60_000;
            break;
          case 'selection':
            f.setIds(['P1', 'P2']);
            if (!all) input.photoIds = ['P1', 'P2'];
            break;
          case 'boundary':
            break;
        }
        const { authorization: _authorization, ...options } = input;
        const picked = channels.exportPickDestination.response.parse(
          await invokeExport(handlers, channels.exportPickDestination.name, {
            intent: { operation: all ? 'all' : 'selected', ...options },
          }),
        );
        assert.ok(picked.authorization);
        input.authorization = picked.authorization;
        assert.deepEqual(await invokeExport(handlers, all ? channels.exportRunAll.name : channels.exportRun.name, input), FAILED);
        assert.equal(calls, 0);
        // Even a failed request burns the capability.
        assert.throws(() => f.authority.consume({ ...f.request(), disclosure: f.wire(preview.consent) }), /invalid/u);
      });
    }
  }
});
