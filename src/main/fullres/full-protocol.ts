import { protocol } from 'electron';

import { FULL_SCHEME } from '../../shared/library/full-url.js';
import type { ProtectedMediaService } from '../library/protected-media-service.js';
import { handleFullRequest } from './full-response.js';
import type { FullService } from './full-service.js';

// overlook-full:// (#91): decrypted originals straight to the lightbox —
// memory-only. Every response carries `Cache-Control: no-store` so Chromium
// never writes plaintext full-res bytes into its disk cache; repeat views
// are served from the FullService LRU instead. Scheme privileges register in
// main/protocol-privileges.ts (one registerSchemesAsPrivileged call).

// Unlike the thumbs' <img> path, fetch() enforces CORS: the renderer's
// app origin is cross-origin to this scheme, so responses allow only the
// trusted renderer origin via resolveFullCorsOrigin (never wildcard '*').
/** Call once after app ready; the service is created lazily like the library. */
export function registerFullProtocol(
  getService: () => FullService,
  admit: () => void = () => undefined,
  getProtected?: () => ProtectedMediaService,
): void {
  protocol.handle(FULL_SCHEME, (request) => handleFullRequest(getService, admit, request, getProtected));
}
