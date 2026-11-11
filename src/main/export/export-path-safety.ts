import { isAbsolute, relative, resolve } from 'node:path';

const MAX_FILE_NAME_LENGTH = 1024;
const MAX_EXTENSION_LENGTH = 32;
// eslint-disable-next-line no-control-regex -- NUL and C0/DEL control bytes must be scrubbed from external filenames
const UNSAFE_LEAF_CHARS = /[\\/:\u0000-\u001f\u007f]+/gu;

function boundFileNameLength(name: string): string {
  if (name.length <= MAX_FILE_NAME_LENGTH) return name;
  const dot = name.lastIndexOf('.');
  const candidateExtension = dot > 0 ? name.slice(dot) : '';
  const extension = candidateExtension.length <= MAX_EXTENSION_LENGTH ? candidateExtension : '';
  return `${name.slice(0, Math.max(1, MAX_FILE_NAME_LENGTH - extension.length))}${extension}`;
}

/**
 * Normalizes an untrusted remote/imported display filename into a single safe
 * directory leaf name, or returns `null` when no safe leaf remains.
 */
export function sanitizeImportedFileName(rawName: string): string | null {
  const normalized = rawName.normalize('NFC').trim();
  if (normalized === '' || normalized === '.' || normalized === '..') return null;

  // Strip leading relative-traversal prefixes (`../`, `..\`, `./`) before
  // converting remaining interior separators (e.g. `2026/07/IMG.JPG`) to `_`.
  const withoutTraversalPrefix = normalized.replace(/^(?:\.{1,2}[\\/]+)+/u, '');
  const scrubbed = withoutTraversalPrefix.replace(UNSAFE_LEAF_CHARS, '_').replace(/\.+$/u, '').trim();

  if (scrubbed === '' || scrubbed === '.' || scrubbed === '..') return null;
  if (/^_+\.[A-Za-z0-9]+$/u.test(scrubbed) && withoutTraversalPrefix !== normalized) {
    return null;
  }
  return boundFileNameLength(scrubbed);
}

/**
 * Produces a guaranteed single-leaf export filename even if a legacy catalog
 * row holds unsanitized path segments or traversal sequences.
 */
export function sanitizeExportFileName(fileName: string, fallbackId: string): string {
  const clean = sanitizeImportedFileName(fileName);
  if (clean !== null) return clean;
  const fallback = sanitizeImportedFileName(fallbackId);
  return fallback ?? 'exported-photo';
}

/**
 * Extracts a safe `.ext` suffix from a retained sidecar filename without
 * allowing path separators or traversal segments after the final dot.
 */
export function sanitizeSidecarExtension(sidecarFileName: string): string {
  const dot = sidecarFileName.lastIndexOf('.');
  if (dot <= 0) return '';
  const rawExtension = sidecarFileName.slice(dot + 1);
  const cleanExtension = rawExtension.normalize('NFC').replace(UNSAFE_LEAF_CHARS, '_').replace(/\.+/gu, '').trim();
  if (cleanExtension === '' || cleanExtension.length >= MAX_EXTENSION_LENGTH) return '';
  return `.${cleanExtension}`;
}

/**
 * Resolves `joinPath(destination, fileName)` and asserts the resulting path
 * stays strictly inside `destination` (never `destination` itself or a parent).
 */
export function resolveContainedExportPath(joinPath: (dir: string, name: string) => string, destination: string, fileName: string): string {
  if (
    fileName === '' ||
    fileName === '.' ||
    fileName === '..' ||
    fileName.includes('/') ||
    fileName.includes('\\') ||
    fileName.includes('\0')
  ) {
    throw new Error(`unsafe export leaf filename: ${fileName}`);
  }
  const joined = joinPath(destination, fileName);
  const resolvedRoot = resolve(destination);
  const resolvedTarget = resolve(joined);
  const rel = relative(resolvedRoot, resolvedTarget);
  if (rel === '' || rel === '.' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`export target escapes destination directory: ${fileName}`);
  }
  return joined;
}
