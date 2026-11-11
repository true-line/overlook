#!/usr/bin/env node

// Runs after `changeset version` (see the `changeset:version` script): root versions in
// `package-lock.json` must follow the `package.json` version that Changesets bumped (#1267).

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const STABLE_SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;

export function syncPackageLockVersion({ rootDir = process.cwd() } = {}) {
  const packageJsonPath = join(rootDir, 'package.json');
  const packageLockPath = join(rootDir, 'package-lock.json');

  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  const packageLockText = readFileSync(packageLockPath, 'utf8');
  const packageLock = JSON.parse(packageLockText);
  const version = String(pkg.version ?? '');

  if (!STABLE_SEMVER.test(version)) {
    throw new Error(`Refusing to copy non-stable semver version "${version}" to package-lock.json.`);
  }
  if (packageLock.name !== pkg.name || packageLock.packages?.['']?.name !== pkg.name) {
    throw new Error('Refusing to update package-lock.json because its root package does not match package.json.');
  }

  const previousLockVersion = String(packageLock.version ?? '');
  const previousLockRootVersion = String(packageLock.packages[''].version ?? '');
  packageLock.version = version;
  packageLock.packages[''].version = version;

  const updatedPackageLockText = `${JSON.stringify(packageLock, null, 2)}\n`;
  if (updatedPackageLockText === packageLockText) {
    return {
      updated: false,
      version,
      previousLockVersion,
      previousLockRootVersion,
    };
  }

  writeFileSync(packageLockPath, updatedPackageLockText, 'utf8');
  return {
    updated: true,
    version,
    previousLockVersion,
    previousLockRootVersion,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = syncPackageLockVersion();
  if (result.updated) {
    console.log(
      `package-lock.json versions: ${result.previousLockVersion}/${result.previousLockRootVersion} -> ${result.version}/${result.version}.`,
    );
  } else {
    console.log(`package-lock.json already at ${result.version}.`);
  }
}
