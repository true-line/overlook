import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp, { type Sharp } from 'sharp';

import { transcodeToJpeg, EXPORT_PROCESSING_TIMEOUT_SECONDS } from '../../src/main/export/transcode.js';
import { sampleJpeg } from '../../src/main/library/seed.js';
import { IDENTITY_TRANSFORM } from '../../src/shared/library/edit-revision.js';

test('export configures a supported processing deadline on every native pipeline', async (t) => {
  const prototype = Object.getPrototypeOf(sharp()) as Pick<Sharp, 'timeout'>;
  const timeout = prototype.timeout;
  const seconds: number[] = [];
  t.mock.method(prototype, 'timeout', function (this: Sharp, options: Parameters<Sharp['timeout']>[0]) {
    seconds.push(options.seconds);
    return timeout.call(this, options);
  });
  await transcodeToJpeg(sampleJpeg(1), 'jpeg');
  assert.deepEqual(seconds, [EXPORT_PROCESSING_TIMEOUT_SECONDS]);
  seconds.length = 0;
  await transcodeToJpeg(sampleJpeg(1), 'jpeg', { transform: { ...IDENTITY_TRANSFORM, quarterTurns: 1 } });
  assert.equal(seconds.length, 4, 'metadata, orientation, transform and encoding each have the deadline');
  assert.ok(seconds.every((value) => value === 30));
});

test('abort during one native stage prevents the following edited-export stages', async (t) => {
  const controller = new AbortController();
  const prototype = Object.getPrototypeOf(sharp()) as Pick<Sharp, 'timeout'>;
  const timeout = prototype.timeout;
  let calls = 0;
  t.mock.method(prototype, 'timeout', function (this: Sharp, options: Parameters<Sharp['timeout']>[0]) {
    calls += 1;
    queueMicrotask(() => controller.abort());
    return timeout.call(this, options);
  });
  await assert.rejects(
    transcodeToJpeg(sampleJpeg(2), 'jpeg', {
      transform: { ...IDENTITY_TRANSFORM, quarterTurns: 1 },
      signal: controller.signal,
    }),
    { name: 'AbortError' },
  );
  assert.equal(calls, 1, 'the first native callback retires before cancellation stops the next stage');
});
