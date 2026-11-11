export type FullCorsResolution =
  { readonly allowed: true; readonly headers: Readonly<Record<string, string>> } | { readonly allowed: false };

function parseOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Restricts `overlook-full://` CORS responses to the trusted application
 * renderer origin instead of wildcard `*`.
 *
 * - Non-CORS internal requests (no `Origin` header, e.g. `<video src>`) emit
 *   no CORS header.
 * - Under `ELECTRON_RENDERER_URL`, only that exact origin is allowed.
 * - In packaged / `loadFile` launches (`file://`), Chromium serializes the
 *   renderer document origin as `'null'` or `'file://'`; cross-origin
 *   `http(s):` or foreign scheme origins are rejected.
 */
export function resolveFullCorsOrigin(
  requestOrigin: string | null,
  devRendererUrl: string | undefined = process.env['ELECTRON_RENDERER_URL'],
): FullCorsResolution {
  if (requestOrigin === null) {
    return { allowed: true, headers: {} };
  }
  if (devRendererUrl !== undefined && devRendererUrl !== '') {
    const expected = parseOrigin(devRendererUrl);
    if (expected !== null && requestOrigin === expected) {
      return {
        allowed: true,
        headers: {
          'Access-Control-Allow-Origin': expected,
          Vary: 'Origin',
        },
      };
    }
    return { allowed: false };
  }
  if (requestOrigin === 'null' || requestOrigin === 'file://') {
    return {
      allowed: true,
      headers: {
        'Access-Control-Allow-Origin': requestOrigin,
        Vary: 'Origin',
      },
    };
  }
  return { allowed: false };
}
