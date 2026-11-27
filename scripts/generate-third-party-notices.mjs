#!/usr/bin/env node

// Generate THIRD-PARTY-NOTICES.md — the attribution file for every third-party
// package shipped in a packaged Overlook build (#461). Run it after dependency
// changes; CI's license-policy gate (#462) fails if the committed file drifts
// from what this would produce.
//
//   npm run licenses:notices        # regenerate the committed file
//   npm run licenses:notices -- --check   # exit non-zero if it is stale

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { resolveShippedClosure } from './dependency-closure.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const NOTICES_PATH = path.join(ROOT, 'THIRD-PARTY-NOTICES.md');
const NODE_MODULES_PATH = path.join(ROOT, 'node_modules');

// License texts are read from installed packages, while the closure itself comes from
// the lockfile. That split is deliberate (see dependency-closure.mjs), but it means a
// missing or pruned node_modules yields records whose licenseText is null — which
// renderNotices turns into the same "_No license text file was found_" note used for
// packages that genuinely ship none. Attribution is silently replaced by a placeholder,
// and --check agrees with it because it re-renders from the same input.
//
// A proportional floor cannot catch this: a production-only install drops `electron`
// alone — a devDependency whose runtime IS shipped (BUNDLED_RUNTIME_ROOTS) — and one
// missing record out of ~72 clears any sane threshold while dropping the license of
// something actually distributed. So the expectation is exact: every shipped package
// must resolve a text unless it is known to publish none.
//
// Verified by inspection against the published tarballs. Adding to this list is a
// deliberate act — it asserts a package ships no license file, not that resolution
// happened to fail.
const PACKAGES_WITHOUT_LICENSE_TEXT = new Set([
  'onnxruntime-common',
  // saxes@6.0.0 tarball contains JS, typings, README and package.json, no license file.
  'saxes',
  'sqlite-vec',
  'standardwebhooks',
  'webworkify-webpack',
]);

export function assertLicenseTextsResolvable(closure) {
  if (!existsSync(NODE_MODULES_PATH)) {
    throw new Error(
      'node_modules is absent, so no license texts can be read. Generating now would ' +
        'produce a notices file with every attribution replaced by a "no license text" ' +
        'note. Run: npm install',
    );
  }

  // Optional platform variants (sharp's per-OS binaries) are in the lockfile union but
  // installed on only one host, so they legitimately resolve nothing here.
  const unexpected = closure
    .filter((pkg) => !pkg.conditional && !pkg.licenseText && !PACKAGES_WITHOUT_LICENSE_TEXT.has(pkg.name))
    .map((pkg) => pkg.name);

  if (unexpected.length > 0) {
    throw new Error(
      `No license text resolved for shipped package(s): ${unexpected.join(', ')}. This ` +
        'usually means node_modules is pruned or stale — a production-only install omits ' +
        'electron, whose runtime is shipped. Run a full npm install. If a package genuinely ' +
        'publishes no license file, add it to PACKAGES_WITHOUT_LICENSE_TEXT after verifying ' +
        'that against its published tarball.',
    );
  }
}

const HEADER = `# Third-Party Notices

Overlook is distributed as a packaged desktop application that bundles the
third-party software listed below. This file is generated — do not edit it by
hand. Regenerate it with \`npm run licenses:notices\` after changing
dependencies.

The bundled Electron runtime additionally embeds Chromium, Node.js, and other
components; their full license texts ship inside the Electron distribution at
\`LICENSES.chromium.html\` and are incorporated here by reference.
`;

export function renderNotices(closure) {
  const summary = closure.map((pkg) => `| \`${pkg.name}\` | ${pkg.version} | ${pkg.license} |`).join('\n');

  const details = closure
    .map((pkg) => {
      const heading = `## ${pkg.name} ${pkg.version}\n\nLicense: ${pkg.license}`;
      const body = pkg.licenseText
        ? `\n\n\`\`\`\n${pkg.licenseText}\n\`\`\``
        : pkg.conditional
          ? '\n\n_Optional/platform-specific package; its full license text ships alongside the binary in the build variant that bundles it._'
          : '\n\n_No license text file was found in the published package._';
      return `${heading}${body}`;
    })
    .join('\n\n---\n\n');

  return `${HEADER}
## Summary

| Package | Version | License |
| ------- | ------- | ------- |
${summary}

---

${details}
`;
}

export function currentNotices() {
  try {
    return readFileSync(NOTICES_PATH, 'utf8');
  } catch {
    return null;
  }
}

function main() {
  const closure = resolveShippedClosure();
  // Guard both paths: a broken environment must not be able to write a stripped file,
  // nor to certify one as current.
  assertLicenseTextsResolvable(closure);
  const rendered = renderNotices(closure);
  const check = process.argv.includes('--check');

  if (check) {
    if (currentNotices() !== rendered) {
      console.error(`THIRD-PARTY-NOTICES.md is stale (covers ${closure.length} packages). Run: npm run licenses:notices`);
      process.exit(1);
    }
    console.log(`THIRD-PARTY-NOTICES.md is up to date (${closure.length} packages).`);
    return;
  }

  writeFileSync(NOTICES_PATH, rendered);
  console.log(`Wrote THIRD-PARTY-NOTICES.md for ${closure.length} shipped packages.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
