import { parseFullUrl, parseProtectedFullUrl } from '../../shared/library/full-url.js';
import type { ProtectedMediaService } from '../library/protected-media-service.js';
import { resolveFullCorsOrigin } from './full-cors.js';
import type { FullService } from './full-service.js';

const NO_STORE_BASE = {
  'Cache-Control': 'no-store',
  'Access-Control-Expose-Headers': 'X-Overlook-Preview',
};

export async function handleFullRequest(
  getService: () => FullService,
  admit: () => void,
  request: Request,
  getProtected?: () => ProtectedMediaService,
): Promise<Response> {
  const cors = resolveFullCorsOrigin(request.headers.get('Origin'));
  if (!cors.allowed) {
    return new Response(null, { status: 403, headers: { 'Cache-Control': 'no-store' } });
  }
  const responseHeaders = { ...NO_STORE_BASE, ...cors.headers };
  try {
    admit();
  } catch {
    return new Response(null, { status: 404, headers: responseHeaders });
  }
  const parsed = parseFullUrl(request.url);
  const protectedTarget = parsed === null ? parseProtectedFullUrl(request.url) : null;
  if (parsed === null && protectedTarget === null) return new Response(null, { status: 400, headers: responseHeaders });
  if (parsed?.prefetch === true) {
    getService().prefetch([parsed.photoId]);
    return new Response(null, { status: 204, headers: responseHeaders });
  }
  if (protectedTarget?.prefetch === true) {
    const protectedService = getProtected?.();
    if (protectedService === undefined || !protectedService.isAuthorized(protectedTarget.albumId, protectedTarget.photoId)) {
      return new Response(null, { status: 404, headers: responseHeaders });
    }
    protectedService.prefetch(protectedTarget.albumId, [protectedTarget.photoId]);
    return new Response(null, { status: 204, headers: responseHeaders });
  }
  // Video streams over Range (ADR-0026 §5) — try it before the still LRU path;
  // null means "not a streamable video", so images fall through unchanged.
  if (parsed !== null) {
    const video = await getService().videoResponse(parsed.photoId, request.headers.get('Range'));
    if (video !== null) {
      return new Response(video.body, { status: video.status, headers: { ...video.headers, ...cors.headers } });
    }
  }
  const payload =
    parsed !== null
      ? await getService().getFull(parsed.photoId, request.signal)
      : protectedTarget === null || getProtected === undefined
        ? null
        : await getProtected().getFull(protectedTarget.albumId, protectedTarget.photoId, request.signal);
  if (payload === null) return new Response(null, { status: 404, headers: responseHeaders });
  return new Response(new Uint8Array(payload.bytes), {
    status: 200,
    headers: {
      ...responseHeaders,
      'Content-Type': payload.mime,
      ...(payload.preview ? { 'X-Overlook-Preview': '1' } : {}),
    },
  });
}
