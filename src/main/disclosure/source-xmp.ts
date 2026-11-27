import { SaxesParser } from 'saxes';

import type { DisclosureField } from '../../shared/disclosure/policy.js';
import type { SourceSidecarFinding } from '../../shared/disclosure/source-sidecars.js';

export const MAX_SOURCE_SIDECAR_BYTES = 5 * 1024 * 1024;
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const DC = 'http://purl.org/dc/elements/1.1/';
const EXIF = 'http://ns.adobe.com/exif/1.0/';
const TIFF = 'http://ns.adobe.com/tiff/1.0/';
const XMP = 'http://ns.adobe.com/xap/1.0/';
const EXIF_EX = 'http://cipa.jp/exif/1.0/';
const AUX = 'http://ns.adobe.com/exif/1.0/aux/';

export type SourceInspection = Pick<SourceSidecarFinding, 'status' | 'fields'>;

function fieldOf(uri: string, local: string): DisclosureField | undefined {
  if (uri === DC) {
    if (local === 'title') return 'title';
    if (local === 'description') return 'description';
    if (local === 'subject') return 'tags';
  }
  if (uri === EXIF && local.startsWith('GPS')) return 'location';
  if ((uri === XMP && local === 'CreateDate') || (uri === EXIF && ['DateTimeOriginal', 'DateTimeDigitized'].includes(local)))
    return 'captureTime';
  if (uri === TIFF && ['Model', 'Make'].includes(local)) return 'camera';
  if ((uri === EXIF_EX && local === 'LensModel') || (uri === AUX && local === 'Lens')) return 'lens';
  return undefined;
}

interface Frame {
  readonly field: DisclosureField | undefined;
  readonly local: string;
  readonly uri: string;
  text: string;
}

/** Strict namespace-aware projection. Never expand a DTD, resolve entities,
 * fetch external resources, or reinterpret a parse error as empty metadata. */
export function inspectSourceXmp(fileName: string, bytes: Buffer): SourceInspection {
  if (!fileName.toLowerCase().endsWith('.xmp')) return { status: 'unknown', fields: [] };
  if (bytes.length === 0 || bytes.length > MAX_SOURCE_SIDECAR_BYTES) return { status: 'malformed', fields: [] };
  const fields = new Map<DisclosureField, Set<string>>();
  const stack: Frame[] = [];
  let rdf = false;
  let nodes = 0;
  const add = (field: DisclosureField, property: string, value: string): void => {
    const values = fields.get(field) ?? new Set<string>();
    values.add(`${property}: ${value.trim()}`);
    fields.set(field, values);
  };
  const parser = new SaxesParser({ xmlns: true });
  parser.on('error', (error) => {
    throw error;
  });
  parser.on('doctype', () => {
    throw new Error('DTD is not accepted in source XMP');
  });
  parser.on('opentag', (tag) => {
    if (++nodes > 100_000 || stack.length >= 64 || Object.keys(tag.attributes).length > 512) throw new Error('XMP complexity limit');
    if (tag.uri === RDF && tag.local === 'RDF') rdf = true;
    const field = fieldOf(tag.uri, tag.local);
    if (field !== undefined && !fields.has(field)) fields.set(field, new Set());
    stack.push({ field, local: tag.local, uri: tag.uri, text: '' });
    for (const attribute of Object.values(tag.attributes)) {
      const attributeField = fieldOf(attribute.uri, attribute.local);
      if (attributeField !== undefined) add(attributeField, attribute.local, attribute.value);
      if (attribute.uri === RDF && ['resource', 'value'].includes(attribute.local)) {
        const owner = [...stack].reverse().find((frame) => frame.field !== undefined);
        if (owner?.field !== undefined) add(owner.field, owner.local, attribute.value);
      }
    }
  });
  const text = (value: string): void => {
    const frame = stack.at(-1);
    if (frame !== undefined) frame.text += value;
  };
  parser.on('text', text);
  parser.on('cdata', text);
  parser.on('closetag', () => {
    const frame = stack.pop();
    if (frame === undefined || frame.text.trim() === '') return;
    const owner = frame.field !== undefined ? frame : [...stack].reverse().find((entry) => entry.field !== undefined);
    if (owner?.field !== undefined) add(owner.field, owner.local, frame.text);
  });
  try {
    parser.write(new TextDecoder('utf-8', { fatal: true }).decode(bytes)).close();
    if (!rdf) return { status: 'malformed', fields: [] };
    return { status: 'inspected', fields: [...fields].map(([field, values]) => ({ field, values: [...values] })) };
  } catch {
    return { status: 'malformed', fields: [] };
  }
}
