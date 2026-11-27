import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createActivityFacade, type ActivityDraft, type ActivityFacade } from '../../src/main/activity/activity-publication.js';
import { registerPhotoKitHandlersWith, type PhotoKitIpcHandlerRegistrar } from '../../src/main/photo-kit/photo-kit-ipc.js';
import type { PhotoKitService } from '../../src/main/photo-kit/photo-kit-service.js';
import { channels } from '../../src/shared/ipc/channels.js';
import type { ExportDisclosureIntentWire } from '../../src/shared/ipc/export-channels.js';
import { consentFixture } from '../disclosure/consent-fixture.js';

const REVIEW_ID = '11111111-1111-4111-8111-111111111111';

describe('PhotoKit IPC adapters (#798)', () => {
  test('validates and projects status, review, import, export, activity, and cancellation', async () => {
    const handlers = new Map<string, (event: unknown, request: unknown) => unknown>();
    const registrar: PhotoKitIpcHandlerRegistrar = {
      handle: (channel, handler) => handlers.set(channel, handler),
    };
    const activity: ActivityDraft[] = [];
    const facade = { record: (draft: ActivityDraft) => activity.push(draft) } as unknown as ActivityFacade;
    let imported = 0;
    let cancelled = 0;
    let admitted = 0;
    let importSummary = {
      imported: 1,
      moved: 0,
      retained: 1,
      duplicates: 0,
      failed: 0,
      cancelled: 0,
      sidecars: 0,
      photoIds: ['imported'],
      moveCompensations: [],
    };
    const service = {
      status: () => ({ available: true, reason: null, importAuthorization: 'authorized', exportAuthorization: 'authorized' }),
      reviewImport: () => Promise.resolve({ status: 'ready', authorization: 'authorized', reviewId: REVIEW_ID, assets: [] }),
      runImport: () => Promise.resolve(importSummary),
      runExport: (photoIds: readonly string[]) =>
        Promise.resolve({
          exported: 1,
          failed: 1,
          cancelled: 0,
          failures: [{ photoId: photoIds[1]!, fileName: 'missing.jpg', reason: 'missing' }],
        }),
      cancel: () => {
        cancelled += 1;
      },
    } as unknown as PhotoKitService;
    registerPhotoKitHandlersWith(
      () => service,
      () => {
        admitted += 1;
      },
      registrar,
      () => {
        imported += 1;
      },
      () => facade,
    );
    const invoke = (channel: string, request: unknown): Promise<unknown> => Promise.resolve(handlers.get(channel)?.({}, request));

    assert.deepEqual(await invoke(channels.photoKitStatus.name, {}), {
      available: true,
      reason: null,
      importAuthorization: 'authorized',
      exportAuthorization: 'authorized',
    });
    assert.deepEqual(await invoke(channels.photoKitImportReview.name, {}), {
      status: 'ready',
      authorization: 'authorized',
      reviewId: REVIEW_ID,
      assets: [],
    });
    assert.deepEqual(await invoke(channels.photoKitImportRun.name, { reviewId: REVIEW_ID, assetIds: ['asset'] }), {
      imported: 1,
      moved: 0,
      retained: 1,
      duplicates: 0,
      failed: 0,
      cancelled: 0,
      sidecars: 0,
    });
    assert.equal(imported, 1);
    assert.deepEqual(activity[0], {
      eventType: 'import.completed',
      outcome: 'succeeded',
      payload: { source: 'apple-photos', mode: 'copy', imported: 1, duplicates: 0, failed: 0, cancelled: 0 },
    });

    importSummary = { ...importSummary, imported: 0, retained: 0, failed: 1, photoIds: [] };
    await invoke(channels.photoKitImportRun.name, { reviewId: REVIEW_ID, assetIds: ['asset'] });
    assert.equal(imported, 1);
    assert.equal(activity[1]?.outcome, 'partial');

    assert.deepEqual(await invoke(channels.photoKitExportRun.name, { photoIds: ['photo', 'missing'] }), {
      exported: 1,
      failed: 1,
      cancelled: 0,
      failures: [{ photoId: 'missing', fileName: 'missing.jpg', reason: 'missing' }],
    });
    assert.deepEqual(activity[2], {
      eventType: 'photo.exported',
      entityIds: ['photo', 'missing'],
      outcome: 'partial',
      payload: {
        recipientKind: 'apple-photos',
        format: 'original',
        metadata: 'embedded-supported',
        disclosureClass: 'shared',
        disclosureWidened: '',
        disclosureNarrowed: '',
        exported: 1,
        failed: 1,
        cancelled: 0,
      },
    });
    assert.deepEqual(await invoke(channels.photoKitCancel.name, {}), {});
    assert.equal(cancelled, 1);
    assert.equal(admitted, 4);
  });

  test('keeps optional observers optional', async () => {
    const handlers = new Map<string, (event: unknown, request: unknown) => unknown>();
    const service = {
      runImport: () =>
        Promise.resolve({
          imported: 0,
          moved: 0,
          retained: 0,
          duplicates: 0,
          failed: 0,
          cancelled: 1,
          sidecars: 0,
          photoIds: [],
          moveCompensations: [],
        }),
      runExport: () => Promise.resolve({ exported: 0, failed: 0, cancelled: 1, failures: [] }),
    } as unknown as PhotoKitService;
    registerPhotoKitHandlersWith(
      () => service,
      () => undefined,
      { handle: (channel, handler) => handlers.set(channel, handler) },
    );
    const invoke = (channel: string, request: unknown): Promise<unknown> => Promise.resolve(handlers.get(channel)?.({}, request));

    assert.equal(
      ((await invoke(channels.photoKitImportRun.name, { reviewId: REVIEW_ID, assetIds: ['asset'] })) as { cancelled: number }).cancelled,
      1,
    );
    assert.equal(((await invoke(channels.photoKitExportRun.name, { photoIds: ['photo'] })) as { cancelled: number }).cancelled, 1);
  });
});

describe('PhotoKit operation disclosure consent (#1141)', () => {
  const failed = { __overlookIpcFailure: true, error: { code: 'IPC_HANDLER_FAILED' } };
  const result = { exported: 1, failed: 0, cancelled: 0, failures: [] };

  test('direct raw widening is refused; confirmed widening succeeds once with replay and concurrent reuse refused', async (t) => {
    const f = consentFixture(t);
    const handlers = new Map<string, (event: unknown, request: unknown) => unknown>();
    const received: (ExportDisclosureIntentWire | undefined)[] = [];
    const activity = createActivityFacade(f.db, () => undefined);
    let finish!: () => void;
    registerPhotoKitHandlersWith(
      () =>
        ({
          runExport: (_ids: readonly string[], disclosure?: ExportDisclosureIntentWire) => {
            received.push(disclosure);
            return new Promise<typeof result>((resolve) => {
              finish = () => resolve(result);
            });
          },
        }) as unknown as PhotoKitService,
      () => undefined,
      {
        handle: (channel, handler) => {
          handlers.set(channel, handler);
        },
      },
      undefined,
      () => activity,
      f.authority,
    );
    const invoke = (request: unknown) => Promise.resolve(handlers.get(channels.photoKitExportRun.name)!({}, request));
    assert.deepEqual(
      await invoke({ photoIds: ['P1'], disclosure: { ...f.wire(), operation: { narrow: [], widen: ['location'] } } }),
      failed,
    );
    assert.equal(received.length, 0);
    const preview = await f.authority.preview({ ...f.request('photo-kit'), confirmWidening: true });
    assert.ok(preview.consent);
    const input = { photoIds: ['P1'], disclosure: f.wire(preview.consent) };
    const first = invoke(input);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(received[0]?.operation.widen, ['location']);
    assert.deepEqual(await invoke(input), failed);
    finish();
    assert.deepEqual(await first, result);
    const events = activity.page(10).events;
    assert.equal(events[0]?.payload['disclosureWidened'], 'location');
    assert.equal(events[0]?.payload['disclosureClass'], 'shared');
    assert.equal(events[0]?.payload['recipientKind'], 'apple-photos');
    assert.ok(!JSON.stringify(events).includes(preview.consent));
    assert.ok(!JSON.stringify(events).includes('52.37'));
    assert.deepEqual(await invoke(input), failed);
    assert.equal(received.length, 1);
  });

  for (const change of [
    'photo',
    'destination',
    'boundary',
    'narrow',
    'widen',
    'policy',
    'override',
    'value',
    'lock',
    'library',
    'expiry',
  ] as const) {
    test(`refuses ${change} mismatch/invalidation before the already-authorized Photos bridge`, async (t) => {
      const f = consentFixture(t);
      const handlers = new Map<string, (event: unknown, request: unknown) => unknown>();
      let calls = 0;
      registerPhotoKitHandlersWith(
        () =>
          ({
            runExport: () => {
              calls++;
              return Promise.resolve(result);
            },
          }) as unknown as PhotoKitService,
        () => undefined,
        {
          handle: (channel, handler) => {
            handlers.set(channel, handler);
          },
        },
        undefined,
        undefined,
        f.authority,
      );
      const preview = await f.authority.preview({ ...f.request(change === 'boundary' ? 'export' : 'photo-kit'), confirmWidening: true });
      const input = { photoIds: ['P1'], disclosure: f.wire(preview.consent) };
      switch (change) {
        case 'photo':
          input.photoIds = ['P2'];
          break;
        case 'destination':
          input.disclosure.destination = 'public';
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
        case 'boundary':
          break;
      }
      assert.deepEqual(await handlers.get(channels.photoKitExportRun.name)!({}, input), failed);
      assert.equal(calls, 0);
      await assert.rejects(() => f.authority.consume({ ...f.request('photo-kit'), disclosure: f.wire(preview.consent) }), /invalid/u);
    });
  }
});
