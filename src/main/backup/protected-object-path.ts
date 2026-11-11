import { isProtectedBlobKind, type ProtectedBlobKind } from '../blobs/protected-blob-store.js';

const OPAQUE_REF = /^[a-f0-9]{64}$/u;

/** Flat provider namespace: the HMAC blob ref is already domain-scoped, and
 * omitting album ids prevents provider-side reconstruction of membership. */
export function protectedObjectPath(blobRef: string, kind: ProtectedBlobKind): string {
  if (!OPAQUE_REF.test(blobRef)) throw new Error('protected object reference is invalid');
  if (!isProtectedBlobKind(kind)) throw new Error('protected object kind is invalid');
  return `protected/${blobRef.slice(0, 2)}/${blobRef}.${kind}`;
}
