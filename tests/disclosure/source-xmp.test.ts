import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, test } from 'node:test';

import { inspectSourceSidecar, readSourceSidecar, sourceSidecarFinding } from '../../src/main/disclosure/source-sidecars.js';
import { inspectSourceXmp, MAX_SOURCE_SIDECAR_BYTES } from '../../src/main/disclosure/source-xmp.js';
import { compileDisclosurePlan, DEFAULT_DISCLOSURE_POLICY } from '../../src/shared/disclosure/policy.js';

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const XMP = `<rdf:RDF xmlns:rdf="${RDF}" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:g="http://ns.adobe.com/exif/1.0/" xmlns:x="http://ns.adobe.com/xap/1.0/" xmlns:t="http://ns.adobe.com/tiff/1.0/" xmlns:l="http://cipa.jp/exif/1.0/">
<rdf:Description g:GPSLatitude="52.37N" g:GPSLongitude="4.9E" x:CreateDate="2026-09-02" t:Model="Leica" l:LensModel="Summilux">
<dc:title><rdf:Alt><rdf:li xml:lang="en">A &amp; B</rdf:li><rdf:li xml:lang="fr">C</rdf:li></rdf:Alt></dc:title>
<dc:description><![CDATA[exact <value>]]></dc:description><dc:subject><rdf:Bag><rdf:li>one</rdf:li><rdf:li>two</rdf:li></rdf:Bag></dc:subject>
<g:DateTimeOriginal>2026-01-01</g:DateTimeOriginal></rdf:Description></rdf:RDF>`;

describe('retained source XMP inspection (#1142)', () => {
  test('finds attributes, elements, arrays, CDATA and entities by namespace URI, including aliased prefixes', () => {
    const result = inspectSourceXmp('PHOTO.XMP', Buffer.from(XMP));
    assert.equal(result.status, 'inspected');
    const values = (field: string) => result.fields.find((entry) => entry.field === field)?.values;
    assert.deepEqual(values('title'), ['title: A & B', 'title: C']);
    assert.deepEqual(values('description'), ['description: exact <value>']);
    assert.deepEqual(values('tags'), ['subject: one', 'subject: two']);
    assert.deepEqual(values('location'), ['GPSLatitude: 52.37N', 'GPSLongitude: 4.9E']);
    assert.deepEqual(values('captureTime'), ['CreateDate: 2026-09-02', 'DateTimeOriginal: 2026-01-01']);
    assert.deepEqual(values('camera'), ['Model: Leica']);
    assert.deepEqual(values('lens'), ['LensModel: Summilux']);
  });

  for (const [label, xml] of [
    ['truncated', XMP.slice(0, -10)],
    ['mismatched tags', XMP.replace('</dc:title>', '</dc:subject>')],
    ['unbound prefix', `<rdf:RDF xmlns:rdf="${RDF}"><exif:GPSLatitude>1</exif:GPSLatitude></rdf:RDF>`],
    ['external entity', `<!DOCTYPE x [<!ENTITY secret SYSTEM "file:///private/secret">]>${XMP}`],
    ['entity expansion', `<!DOCTYPE x [<!ENTITY x "&x;&x;">]>${XMP}`],
    ['multiple roots', `${XMP}${XMP}`],
    ['not XMP', '<anything/>'],
    ['empty', ''],
    ['too deep', `<rdf:RDF xmlns:rdf="${RDF}">${'<a>'.repeat(70)}${'</a>'.repeat(70)}</rdf:RDF>`],
  ])
    test(`refuses ${label}, never returning partial findings as inspected`, () => {
      assert.deepEqual(inspectSourceXmp('photo.xmp', Buffer.from(xml ?? '')), { status: 'malformed', fields: [] });
    });

  test('refuses invalid UTF-8 and oversized data; does not guess unknown formats', () => {
    assert.equal(inspectSourceXmp('photo.xmp', Buffer.from([0xff])).status, 'malformed');
    assert.equal(inspectSourceXmp('photo.xmp', Buffer.alloc(MAX_SOURCE_SIDECAR_BYTES + 1)).status, 'malformed');
    assert.equal(inspectSourceXmp('photo.aae', Buffer.from(XMP)).status, 'unknown');
  });

  test('bounded reads authenticate content identities and close their stream on failure', async () => {
    const bytes = Buffer.from(XMP);
    const sidecar = { fileName: 'photo.xmp', bytes: bytes.length, keyId: 1, contentHash: createHash('sha256').update(bytes).digest('hex') };
    assert.deepEqual(await readSourceSidecar(sidecar, () => Readable.from([bytes])), bytes);
    assert.equal((await inspectSourceSidecar(sidecar, () => Readable.from(['substituted']))).status, 'unavailable');
    assert.equal(
      (
        await inspectSourceSidecar(sidecar, () => {
          throw new Error('key missing');
        })
      ).status,
      'unavailable',
    );
    assert.equal(
      (
        await inspectSourceSidecar({ ...sidecar, bytes: MAX_SOURCE_SIDECAR_BYTES + 1 }, () => {
          throw new Error('must not open');
        })
      ).status,
      'malformed',
    );
    const excessive = Readable.from([Buffer.alloc(MAX_SOURCE_SIDECAR_BYTES + 1)]);
    await assert.rejects(
      readSourceSidecar(sidecar, () => excessive),
      /limit/u,
    );
    assert.equal(excessive.destroyed, true);
  });

  test('unknown fields fail closed unless the entire export plan allows them; malformed XMP always refuses', () => {
    const plan = compileDisclosurePlan({ boundary: 'export', destination: 'shared', chain: { library: DEFAULT_DISCLOSURE_POLICY } });
    const sidecar = { fileName: 'photo.aae', bytes: 0, keyId: 1, contentHash: '' };
    const unknown = { status: 'unknown', fields: [] } as const;
    assert.deepEqual(sourceSidecarFinding('P', sidecar, { ...unknown, fields: [] }, plan).blocked, ['location']);
    const allowed = compileDisclosurePlan({
      boundary: 'export',
      destination: 'shared',
      chain: { library: DEFAULT_DISCLOSURE_POLICY },
      operation: { narrow: [], widen: ['location'] },
    });
    assert.equal(sourceSidecarFinding('P', sidecar, { ...unknown, fields: [] }, allowed).refused, false);
    assert.equal(sourceSidecarFinding('P', sidecar, { status: 'malformed', fields: [] }, allowed).refused, true);
  });
});
