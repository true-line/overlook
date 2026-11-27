import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { authorizeDisclosure } from '../../src/main/disclosure/disclosure-consent.js';
import { confirmDisclosureWidening } from '../../src/main/disclosure/disclosure-confirmation.js';
import { consentFixture } from './consent-fixture.js';

describe('main-owned disclosure consent (#1141)', () => {
  test('the native ceremony defaults to Cancel and requires the affirmative button', async () => {
    for (const response of [0, 1, -1]) {
      assert.equal(
        await confirmDisclosureWidening('exact values from main', (options) => {
          assert.equal(options.defaultId, 0);
          assert.equal(options.cancelId, 0);
          assert.equal(options.detail, 'exact values from main');
          assert.deepEqual(options.buttons, ['Cancel', 'Include for this export']);
          return Promise.resolve({ response });
        }),
        response === 1,
      );
    }
  });

  test('overlapping consent prompts and unknown capabilities fail closed', async (t) => {
    const f = consentFixture(t);
    let answer!: (confirmed: boolean) => void;
    f.setConfirm(
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
        }),
    );
    const pending = f.authority.preview({ ...f.request(), confirmWidening: true });
    await assert.rejects(f.authority.preview({ ...f.request(), confirmWidening: true }), /already open/u);
    await new Promise<void>((resolve) => setImmediate(resolve));
    answer(false);
    await pending;
    const request = { ...f.request(), disclosure: f.wire('11111111-1111-4111-8111-111111111111') };
    await assert.rejects(() => f.authority.consume(request), /invalid/u);
    await assert.rejects(() => authorizeDisclosure(undefined, request), /unavailable/u);
  });
  test('passive previews and cancelled native confirmations mint no authority; ordinary exports need none', async (t) => {
    const f = consentFixture(t);
    assert.equal((await f.authority.preview(f.request())).consent, undefined);
    assert.equal(f.prompts.length, 0);
    f.state.confirmed = false;
    assert.equal((await f.authority.preview({ ...f.request(), confirmWidening: true })).consent, undefined);
    const detail = f.prompts[0];
    assert.ok(detail);
    assert.match(detail, /location \(private, crosses\): "52.37, 4.9"/u);
    assert.match(detail, /Declining stops this export/u);
    assert.match(detail, /Export folder \(shared\)/u);
    assert.deepEqual(await authorizeDisclosure(undefined, { boundary: 'export', payload: 'baked' }), {
      photoIds: undefined,
      disclosure: undefined,
    });
    await assert.rejects(
      () =>
        authorizeDisclosure(undefined, {
          boundary: 'export',
          payload: 'original',
          disclosure: { ...f.wire(), operation: { narrow: [], widen: ['location'] } },
        }),
      /location/u,
    );
  });

  test('affirmative confirmation supplies stored widening once, never trusting renderer fields', async (t) => {
    const f = consentFixture(t);
    const preview = await f.authority.preview({ ...f.request(), confirmWidening: true });
    assert.ok(preview.consent);
    const run = { ...f.request(), disclosure: f.wire(preview.consent) };
    const authorized = await f.authority.consume(run);
    assert.deepEqual(authorized.disclosure.operation, { narrow: [], widen: ['location'] });
    authorized.disclosure.assertCurrent?.();
    await assert.rejects(() => f.authority.consume(run), /invalid/u);
    f.service.setField('title', 'private');
    assert.throws(() => authorized.disclosure.assertCurrent?.(), /no longer current/u);
  });

  for (const change of ['policy', 'override', 'lock', 'library', 'expiry', 'selection', 'value'] as const) {
    test(`invalidation on ${change} also applies while native consent is pending`, async (t) => {
      const f = consentFixture(t);
      let answer!: (confirmed: boolean) => void;
      f.setConfirm(
        () =>
          new Promise<boolean>((resolve) => {
            answer = resolve;
          }),
      );
      const request = { ...f.request(), photoIds: undefined, confirmWidening: true };
      const pending = f.authority.preview(request);
      await new Promise<void>((resolve) => setImmediate(resolve));
      switch (change) {
        case 'policy':
          f.service.setField('title', 'private');
          break;
        case 'override':
          f.service.setOverride('photo', 'P1', 'title', 'private');
          break;
        case 'lock':
          f.state.epoch += 2;
          break;
        case 'library':
          f.state.library = 'other-library';
          break;
        case 'selection':
          f.setIds(['P1', 'P2']);
          break;
        case 'value':
          f.db.prepare('UPDATE photos SET gps_lat = 1 WHERE id = ?').run('P1');
          break;
        case 'expiry':
          f.state.now += 5 * 60_000;
          break;
      }
      answer(true);
      if (change === 'expiry') {
        // Lifetime starts at issuance, after the user confirms.
        assert.ok((await pending).consent);
      } else await assert.rejects(pending, /changed/u);
    });
  }
});
