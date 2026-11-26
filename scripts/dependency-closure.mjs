#!/usr/bin/env node

// Resolve the set of third-party packages shipped in packaged Overlook builds,
// for licensing compliance (#461) and the license-policy gate (#462). Both the
// notices generator and the checker import from here so they audit exactly the
// same closure.
//
// The closure is resolved from package-lock.json, NOT from installed
// node_modules, so it is identical on every OS. That matters because sharp
// pulls in per-platform prebuilt binaries (`@img/sharp-*`, `@img/sharp-libvips-*`)
// as optional dependencies: a macOS checkout installs only the darwin ones, a
// Linux CI runner only the linux ones. Walking node_modules would make the gate
// and the committed notices depend on where they ran. The lockfile lists every
// platform variant, so the union — which is what actually gets distributed
// across the mac and Windows build targets — is covered deterministically.
//
// "Shipped" = every lockfile entry that is not dev-only (`dev !== true`), i.e.
// the production closure of `dependencies`/`optionalDependencies` including all
// their transitive prod deps and platform variants. electron is a devDependency
// by electron-builder convention but its runtime IS shipped, so it is added
// explicitly as a leaf (its own npm dependencies are install-time tooling that
// never ships, and are dev-only in the lockfile anyway).

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCK_PATH = path.join(ROOT, 'package-lock.json');

// devDependencies whose runtime nonetheless ships inside the packaged app.
export const BUNDLED_RUNTIME_ROOTS = ['electron'];

const LICENSE_FILE_PATTERN = /^(?:licen[cs]e|copying|notice|unlicense)(?:[.-].*)?$/iu;

// Normalize the `license` field recorded in a lockfile entry (a string, or
// absent) into a single SPDX-ish token. `UNKNOWN` when nothing is declared.
export function normalizeLicense(entry) {
  if (typeof entry.license === 'string' && entry.license.trim() !== '') {
    return entry.license.trim();
  }
  if (Array.isArray(entry.license) && entry.license.length > 0) {
    return entry.license.length === 1 ? String(entry.license[0]) : `(${entry.license.join(' OR ')})`;
  }
  return 'UNKNOWN';
}

function readLicenseText(dir) {
  if (!existsSync(dir)) {
    return null;
  }
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  // Preserve supplemental terms such as LICENSE-MIT. Codepoint ordering keeps
  // the generated notices identical across filesystems and locales.
  const matches = entries
    .filter((entry) => entry.isFile() && LICENSE_FILE_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (matches.length === 0) {
    return null;
  }
  try {
    return matches
      .map((name) => {
        const text = readFileSync(path.join(dir, name), 'utf8').replaceAll('\r\n', '\n').trim();
        return matches.length === 1 ? text : `--- ${name} ---\n\n${text}`;
      })
      .join('\n\n');
  } catch {
    return null;
  }
}

function packageNameFromLockKey(key) {
  const marker = 'node_modules/';
  const index = key.lastIndexOf(marker);
  return index === -1 ? key : key.slice(index + marker.length);
}

function recordFor(key, entry) {
  // Only NON-optional packages are guaranteed installed on every platform, so
  // only their license text can be embedded deterministically. Optional
  // packages — the per-platform prebuilt binaries (`@img/sharp-*`,
  // `@img/sharp-libvips-*`) and conditional extras like `@img/sharp-wasm32` /
  // `@emnapi/runtime` — are installed on some runners and not others, so
  // reading their text would make the committed notices depend on where they
  // were generated. For those, carry the SPDX id from the lockfile (which lists
  // every variant) and note the text ships with the build that bundles them.
  const conditional = entry.optional === true || Array.isArray(entry.os) || Array.isArray(entry.cpu);
  const dir = path.join(ROOT, key);
  return {
    name: packageNameFromLockKey(key),
    version: entry.version ?? '0.0.0',
    license: normalizeLicense(entry),
    conditional,
    licenseText: conditional ? null : readLicenseText(dir),
    path: key,
  };
}

/**
 * Resolve the shipped third-party closure as a sorted array of records:
 * `{ name, version, license, platformSpecific, licenseText, path }`.
 * The root package (`private: true`) is first-party and excluded.
 */
export function resolveShippedClosure() {
  const lock = JSON.parse(readFileSync(LOCK_PATH, 'utf8'));
  const packages = lock.packages ?? {};
  const byKey = new Map();

  for (const [key, entry] of Object.entries(packages)) {
    if (!key.startsWith('node_modules/') || entry.link === true) {
      continue;
    }
    if (entry.dev === true) {
      continue;
    }
    byKey.set(key, recordFor(key, entry));
  }

  // Add the bundled runtime roots as leaves, regardless of their dev flag.
  for (const name of BUNDLED_RUNTIME_ROOTS) {
    const key = `node_modules/${name}`;
    const entry = packages[key];
    if (entry) {
      byKey.set(key, recordFor(key, entry));
    }
  }

  const deduped = new Map();
  for (const record of byKey.values()) {
    deduped.set(`${record.name}@${record.version}`, record);
  }

  // Codepoint sort (NOT localeCompare) so the package order in the generated
  // notices is identical on every runner regardless of its locale.
  const byCodepoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return [...deduped.values()].sort((a, b) => byCodepoint(a.name, b.name) || byCodepoint(a.version, b.version));
}
