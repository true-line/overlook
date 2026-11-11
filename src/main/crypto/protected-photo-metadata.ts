import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { z } from 'zod';

import { protectedPhotoMetadataSchema, type ProtectedPhotoMetadata } from './protected-photo-metadata-schema.js';

export type { ProtectedPhotoMetadata } from './protected-photo-metadata-schema.js';

const MAGIC = Buffer.from('OVPP', 'ascii');
const VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAX_RECORD_BYTES = 16 * 1024 * 1024;

const canonicalBase64 = z.string().refine((value) => {
  try {
    return Buffer.from(value, 'base64').toString('base64') === value;
  } catch {
    return false;
  }
}, 'must be canonical base64');

const sealedSchema = z.strictObject({
  version: z.literal(VERSION),
  algorithm: z.literal('AES-256-GCM'),
  nonce: canonicalBase64.refine((value) => Buffer.from(value, 'base64').length === NONCE_BYTES),
  ciphertextAndTag: canonicalBase64.refine((value) => {
    const bytes = Buffer.from(value, 'base64').length;
    return bytes >= TAG_BYTES && bytes <= MAX_RECORD_BYTES;
  }),
});

export class ProtectedPhotoMetadataError extends Error {
  override readonly name = 'ProtectedPhotoMetadataError';
}

function validateKey(albumKey: Buffer): void {
  if (albumKey.length !== 32) throw new ProtectedPhotoMetadataError('protected album key must be 32 bytes');
}

function aad(libraryId: string, albumId: string, photoId: string): Buffer {
  for (const [label, value] of [
    ['library', libraryId],
    ['album', albumId],
    ['photo', photoId],
  ] as const) {
    if (value.length < 1 || value.length > 256) throw new ProtectedPhotoMetadataError(`${label} id is invalid`);
  }
  return Buffer.from(JSON.stringify(['OVPP', VERSION, libraryId, albumId, photoId, 'AES-256-GCM']), 'utf8');
}

export function sealProtectedPhotoMetadata(
  context: { readonly libraryId: string; readonly albumId: string; readonly photoId: string },
  albumKey: Buffer,
  input: ProtectedPhotoMetadata,
): Buffer {
  validateKey(albumKey);
  const metadata = protectedPhotoMetadataSchema.parse(input);
  if (metadata.photo.id !== context.photoId) throw new ProtectedPhotoMetadataError('photo id does not match metadata context');
  const plaintext = Buffer.from(JSON.stringify(metadata), 'utf8');
  try {
    if (plaintext.length + TAG_BYTES > MAX_RECORD_BYTES) throw new ProtectedPhotoMetadataError('protected photo metadata is too large');
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', albumKey, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(aad(context.libraryId, context.albumId, context.photoId));
    const ciphertextAndTag = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
    const sealed = {
      version: VERSION,
      algorithm: 'AES-256-GCM' as const,
      nonce: nonce.toString('base64'),
      ciphertextAndTag: ciphertextAndTag.toString('base64'),
    };
    return Buffer.concat([MAGIC, Buffer.from(JSON.stringify(sealed), 'utf8')]);
  } finally {
    plaintext.fill(0);
  }
}

export function openProtectedPhotoMetadata(
  context: { readonly libraryId: string; readonly albumId: string; readonly photoId: string },
  albumKey: Buffer,
  raw: Buffer,
): ProtectedPhotoMetadata {
  validateKey(albumKey);
  if (raw.length <= MAGIC.length || raw.length > MAX_RECORD_BYTES * 2 || !raw.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new ProtectedPhotoMetadataError('invalid protected photo metadata');
  }
  let plaintext: Buffer | undefined;
  try {
    const json = raw.subarray(MAGIC.length).toString('utf8');
    const sealed = sealedSchema.parse(JSON.parse(json) as unknown);
    if (JSON.stringify(sealed) !== json) throw new ProtectedPhotoMetadataError('invalid protected photo metadata');
    const bytes = Buffer.from(sealed.ciphertextAndTag, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', albumKey, Buffer.from(sealed.nonce, 'base64'), { authTagLength: TAG_BYTES });
    decipher.setAAD(aad(context.libraryId, context.albumId, context.photoId));
    decipher.setAuthTag(bytes.subarray(-TAG_BYTES));
    plaintext = Buffer.concat([decipher.update(bytes.subarray(0, -TAG_BYTES)), decipher.final()]);
    const metadataJson = plaintext.toString('utf8');
    const metadata = protectedPhotoMetadataSchema.parse(JSON.parse(metadataJson) as unknown);
    if (JSON.stringify(metadata) !== metadataJson || metadata.photo.id !== context.photoId) {
      throw new ProtectedPhotoMetadataError('invalid protected photo metadata');
    }
    return metadata;
  } catch (error) {
    if (error instanceof ProtectedPhotoMetadataError) throw error;
    throw new ProtectedPhotoMetadataError('invalid protected photo metadata');
  } finally {
    plaintext?.fill(0);
  }
}
