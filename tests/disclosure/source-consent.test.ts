import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { describe, test, type TestContext } from 'node:test';

import { ExportEngine } from '../../src/main/export/export-engine.js';
import { consentFixture } from './consent-fixture.js';

const GPS =
  '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:e="http://ns.adobe.com/exif/1.0/"><rdf:Description e:GPSLatitude="52.37N"/></rdf:RDF>';
const SAFE =
  '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:d="http://purl.org/dc/elements/1.1/"><rdf:Description d:title="Source title"/></rdf:RDF>';

function sourceWorld(t: TestContext, text = GPS, fileName = 'P1.xmp') {
  let bytes = Buffer.from(text);
  const descriptor = () => ({
    fileName,
    bytes: bytes.length,
    keyId: 1,
    ownerId: 'P1',
    contentHash: createHash('sha256').update(bytes).digest('hex'),
  });
  let sidecar = descriptor();
  let stream = () => Readable.from([bytes]);
  let reads = 0;
  const reader = {
    sidecarsFor: () => [sidecar],
    sidecarStream: () => {
      reads++;
      return stream();
    },
  };
  const f = consentFixture(t, reader);
  f.db.prepare('UPDATE photos SET gps_lat = NULL, gps_lon = NULL').run();
  const written = new Map<string, Buffer>();
  const engine = new ExportEngine({
    repo: { get: (id) => f.photos.get(id) },
    blobs: { getStream: () => Readable.from(['original']) },
    resolveKey: () => Buffer.alloc(32),
    ...reader,
    disclosure: (id, intent) => f.service.plan(id, 'export', intent.destination, intent.operation),
    writeFile: async (path, input) => {
      written.set(path, await buffer(input));
    },
    exists: () => Promise.resolve(false),
    freeBytes: () => Promise.resolve(Number.MAX_SAFE_INTEGER),
    joinPath: join,
    transcodeJpeg: (input) => Promise.resolve({ jpeg: input, fromPreview: false }),
    bufferStream: buffer,
    events: { progress: () => undefined },
  });
  const request = { ...f.request(), mode: 'original-sidecars' as const };
  return {
    ...f,
    engine,
    request,
    written,
    reads: () => reads,
    bytes: () => bytes,
    replace: (text: string) => {
      bytes = Buffer.from(text);
      sidecar = descriptor();
    },
    tamper: () => {
      bytes = Buffer.from('changed without changing its identity');
    },
    setStream: (next: () => Readable) => {
      stream = next;
    },
  };
}

describe('source companion consent and preview (#1142)', () => {
  test('preview bounds aggregate inspection and refuses companions it cannot establish within the budget', async (t) => {
    let opens = 0;
    const f = consentFixture(t, {
      sidecarsFor: () =>
        Array.from({ length: 10 }, (_, index) => ({
          fileName: `${String(index)}.xmp`,
          bytes: 5 * 1024 * 1024,
          keyId: 1,
          contentHash: 'a'.repeat(64),
        })),
      sidecarStream: () => {
        opens++;
        throw new Error('unavailable');
      },
    });
    const preview = await f.service.preview({ ...f.request(), mode: 'original-sidecars' });
    assert.equal(opens, 6);
    assert.equal(preview.sourceSidecars?.length, 10);
    assert.ok(preview.sourceSidecars?.every((sidecar) => sidecar.refused));
    assert.equal(preview.sourceSidecars?.[6]?.reason, 'budget');
  });
  test('source-only fields appear in preview and native consent, then an issued token permits exact original bytes once', async (t) => {
    const f = sourceWorld(t);
    const preview = await f.service.preview({ ...f.request, operation: { narrow: [], widen: [] } });
    assert.deepEqual(preview.embedded, []);
    assert.deepEqual(preview.blocked, ['location']);
    assert.equal(preview.sourceSidecars?.[0]?.status, 'inspected');
    assert.deepEqual(preview.sourceSidecars?.[0]?.fields, [{ field: 'location', values: ['GPSLatitude: 52.37N'] }]);
    const issued = await f.authority.preview({ ...f.request, confirmWidening: true });
    assert.ok(issued.consent);
    assert.match(f.prompts.join('\n'), /P1.xmp.*inspected/u);
    assert.match(f.prompts.join('\n'), /GPSLatitude: 52.37N/u);
    const run = { ...f.request, disclosure: f.wire(issued.consent) };
    const authorized = await f.authority.consume(run);
    const result = await f.engine.exportPhotos(['P1'], '/chosen', undefined, 'original', 'original', undefined, authorized.disclosure);
    assert.equal(result.exported, 1);
    assert.deepEqual(f.written.get('/chosen/P1.xmp'), f.bytes());
    await assert.rejects(f.authority.consume(run), /invalid/u);
  });

  test('safe XMP does not require widening merely because location is private', async (t) => {
    const f = sourceWorld(t, SAFE);
    const preview = await f.service.preview({ ...f.request, operation: { narrow: [], widen: [] } });
    assert.deepEqual(preview.blocked, []);
    assert.deepEqual(preview.sourceSidecars?.[0]?.fields, [{ field: 'title', values: ['title: Source title'] }]);
    assert.equal((await f.engine.exportPhotos(['P1'], '/chosen')).exported, 1);
  });

  test('unknown formats need all withheld fields allowed and native consent clearly states unknown values', async (t) => {
    const f = sourceWorld(t, '<unknown/>', 'P1.aae');
    await assert.rejects(f.engine.exportPhotos(['P1'], '/chosen'), /P1.aae.*unknown.*location/u);
    assert.equal(f.written.size, 0);
    const issued = await f.authority.preview({ ...f.request, confirmWidening: true });
    assert.ok(issued.consent);
    assert.match(f.prompts.join('\n'), /field values unknown/u);
    const authorized = await f.authority.consume({ ...f.request, disclosure: f.wire(issued.consent) });
    assert.equal(
      (await f.engine.exportPhotos(['P1'], '/chosen', undefined, 'original', 'original', undefined, authorized.disclosure)).exported,
      1,
    );
  });

  for (const metadata of ['overlook', 'none'] as const)
    test(`${metadata} omits malformed/unreadable source companions without opening them`, async (t) => {
      const f = sourceWorld(t, '<broken');
      f.setStream(() => {
        throw new Error('must not read an omitted companion');
      });
      const preview = await f.service.preview({ ...f.request, metadata });
      assert.deepEqual(preview.sourceSidecars, []);
      assert.equal((await f.engine.exportPhotos(['P1'], '/chosen', undefined, 'original', metadata)).exported, 1);
      assert.equal(f.reads(), 0);
      assert.ok(!f.written.has('/chosen/P1.xmp'));
    });

  test('malformed known XMP refuses even after all fields are widened and cannot mint consent', async (t) => {
    const f = sourceWorld(t, '<broken');
    await assert.rejects(
      f.engine.exportPhotos(['P1'], '/chosen', undefined, 'original', 'original', undefined, {
        destination: 'shared',
        operation: { narrow: [], widen: ['location'] },
      }),
      /malformed/u,
    );
    await assert.rejects(f.authority.preview({ ...f.request, confirmWidening: true }), /cannot be inspected/u);
    assert.equal(f.written.size, 0);
    assert.equal(f.prompts.length, 0);
  });

  for (const change of ['replace', 'tamper'] as const)
    test(`${change} after confirmation invalidates the bound companion`, async (t) => {
      const f = sourceWorld(t);
      const issued = await f.authority.preview({ ...f.request, confirmWidening: true });
      if (change === 'replace') f.replace(SAFE);
      else f.tamper();
      await assert.rejects(f.authority.consume({ ...f.request, disclosure: f.wire(issued.consent) }), /does not match/u);
      assert.equal(f.written.size, 0);
    });

  test('changing a companion after redemption fails the continuation guard; tampered bytes refuse before output', async (t) => {
    const f = sourceWorld(t);
    const issued = await f.authority.preview({ ...f.request, confirmWidening: true });
    const authorized = await f.authority.consume({ ...f.request, disclosure: f.wire(issued.consent) });
    f.tamper();
    await assert.rejects(
      f.engine.exportPhotos(['P1'], '/chosen', undefined, 'original', 'original', undefined, authorized.disclosure),
      /unavailable/u,
    );
    assert.equal(f.written.size, 0);
    f.replace(SAFE);
    assert.throws(() => authorized.disclosure.assertCurrent?.(), /no longer current/u);
  });

  test('a capability is burned before awaiting companion inspection, preventing concurrent redemption', async (t) => {
    const f = sourceWorld(t);
    const issued = await f.authority.preview({ ...f.request, confirmWidening: true });
    const input = new Readable({
      read() {
        /* Controlled inspection race. */
      },
    });
    f.setStream(() => input);
    const run = { ...f.request, disclosure: f.wire(issued.consent) };
    const first = f.authority.consume(run);
    await assert.rejects(f.authority.consume(run), /invalid/u);
    input.push(f.bytes());
    input.push(null);
    assert.deepEqual((await first).disclosure.operation.widen, ['location']);
  });

  test('lock during asynchronous inspection prevents issuance', async (t) => {
    const f = sourceWorld(t);
    const input = new Readable({
      read() {
        /* Controlled inspection race. */
      },
    });
    f.setStream(() => input);
    const pending = f.authority.preview({ ...f.request, confirmWidening: true });
    f.state.epoch++;
    input.push(f.bytes());
    input.push(null);
    await assert.rejects(pending, /changed/u);
    assert.equal(f.prompts.length, 0);
  });
});
