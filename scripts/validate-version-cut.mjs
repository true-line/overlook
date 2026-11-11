#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const VERSIONED_FILES = ['CHANGELOG.md', 'package-lock.json', 'package.json'];
const CHANGESET_PATH = /^\.changeset\/(?!README\.md$)[A-Za-z0-9][A-Za-z0-9_-]*\.md$/u;
const STABLE_SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;

function sameJson(left, right) {
  return isDeepStrictEqual(left, right);
}

function semverParts(version) {
  return STABLE_SEMVER.test(version) ? version.split('.').map(Number) : null;
}

function isVersionAdvance(next, previous) {
  const nextParts = semverParts(next);
  const previousParts = semverParts(previous);
  if (!nextParts || !previousParts) return false;
  for (let index = 0; index < nextParts.length; index += 1) {
    if (nextParts[index] !== previousParts[index]) return nextParts[index] > previousParts[index];
  }
  return false;
}

export function validateChangedEntries(entries, pendingChangesets) {
  const errors = [];
  const seen = new Set();
  const deletedChangesets = new Set();

  for (const { path, status } of entries) {
    if (seen.has(path)) errors.push(`version patch repeats "${path}"`);
    seen.add(path);
    if (VERSIONED_FILES.includes(path)) {
      if (status !== 'M') errors.push(`${path} must be modified, got status ${status}`);
      continue;
    }
    if (!CHANGESET_PATH.test(path)) {
      errors.push(`version patch changes forbidden path "${path}"`);
      continue;
    }
    if (status !== 'D') errors.push(`${path} must be deleted, got status ${status}`);
    deletedChangesets.add(path);
  }

  for (const path of VERSIONED_FILES) {
    if (!seen.has(path)) errors.push(`version patch must modify ${path}`);
  }
  if (pendingChangesets.length === 0) errors.push('version cut requires at least one pending changeset');
  for (const path of pendingChangesets) {
    if (!deletedChangesets.has(path)) errors.push(`version patch must consume pending changeset ${path}`);
  }
  for (const path of deletedChangesets) {
    if (!pendingChangesets.includes(path)) errors.push(`version patch deletes non-pending changeset ${path}`);
  }
  return errors;
}

export function validateVersionDocuments({ basePackage, nextPackage, baseLock, nextLock, baseChangelog, nextChangelog }) {
  const errors = [];
  const nextVersion = String(nextPackage.version ?? '');
  const baseVersion = String(basePackage.version ?? '');

  if (!isVersionAdvance(nextVersion, baseVersion)) {
    errors.push(`package version must advance from stable ${baseVersion} to stable ${nextVersion}`);
  }
  if (nextLock.version !== nextVersion || nextLock.packages?.['']?.version !== nextVersion) {
    errors.push('package and lockfile versions are not synchronized');
  }

  const expectedPackage = structuredClone(basePackage);
  expectedPackage.version = nextVersion;
  if (!sameJson(nextPackage, expectedPackage)) errors.push('package.json changes fields other than version');

  const expectedLock = structuredClone(baseLock);
  expectedLock.version = nextVersion;
  if (expectedLock.packages?.['']) expectedLock.packages[''].version = nextVersion;
  if (!sameJson(nextLock, expectedLock)) errors.push('package-lock.json changes fields other than synchronized root versions');

  const headerMatch = /^# [^\n]+\n\n/u.exec(baseChangelog);
  if (!headerMatch) {
    errors.push('base CHANGELOG.md has an unexpected header');
  } else {
    const changelogHeader = headerMatch[0];
    const oldEntries = baseChangelog.slice(changelogHeader.length);
    const expectedPrefix = `${changelogHeader}## ${nextVersion}\n\n`;
    if (
      !nextChangelog.startsWith(expectedPrefix) ||
      !nextChangelog.endsWith(oldEntries) ||
      nextChangelog.length <= expectedPrefix.length + oldEntries.length
    ) {
      errors.push(`CHANGELOG.md must prepend exactly one ${nextVersion} section before the prior entries`);
    }
  }

  return errors;
}

function gitOutput(rootDir, arguments_, encoding = 'utf8') {
  return execFileSync('git', arguments_, { cwd: rootDir, encoding, maxBuffer: 16 * 1024 * 1024 });
}

function readBaseJson(rootDir, path) {
  return JSON.parse(gitOutput(rootDir, ['show', `HEAD:${path}`]));
}

function readJson(rootDir, path) {
  return JSON.parse(readFileSync(join(rootDir, path), 'utf8'));
}

function stagedEntries(rootDir) {
  const fields = gitOutput(rootDir, ['diff', '--cached', '--name-status', '--no-renames', '-z', 'HEAD'], 'buffer')
    .toString('utf8')
    .split('\0');
  if (fields.at(-1) === '') fields.pop();
  if (fields.length % 2 !== 0) throw new Error('could not parse staged version-cut paths');
  const entries = [];
  for (let index = 0; index < fields.length; index += 2) {
    entries.push({ status: fields[index], path: fields[index + 1] });
  }
  return entries;
}

function pendingChangesets(rootDir) {
  return gitOutput(rootDir, ['ls-tree', '-r', '--name-only', '-z', 'HEAD', '.changeset'])
    .split('\0')
    .filter((path) => CHANGESET_PATH.test(path));
}

export function validateStagedVersionCut({ rootDir = process.cwd() } = {}) {
  const entries = stagedEntries(rootDir);
  const pending = pendingChangesets(rootDir);
  const errors = validateChangedEntries(entries, pending);

  for (const path of VERSIONED_FILES) {
    if (!lstatSync(join(rootDir, path)).isFile()) errors.push(`${path} must remain a regular file`);
  }
  for (const path of pending) {
    try {
      lstatSync(join(rootDir, path));
      errors.push(`${path} must be removed from the version cut`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  errors.push(
    ...validateVersionDocuments({
      basePackage: readBaseJson(rootDir, 'package.json'),
      nextPackage: readJson(rootDir, 'package.json'),
      baseLock: readBaseJson(rootDir, 'package-lock.json'),
      nextLock: readJson(rootDir, 'package-lock.json'),
      baseChangelog: gitOutput(rootDir, ['show', 'HEAD:CHANGELOG.md']),
      nextChangelog: readFileSync(join(rootDir, 'CHANGELOG.md'), 'utf8'),
    }),
  );
  if (errors.length > 0) throw new Error(`Unsafe version cut:\n- ${errors.join('\n- ')}`);

  const version = String(readJson(rootDir, 'package.json').version);
  process.stdout.write(`Validated version cut ${version}: ${entries.length} staged paths, ${pending.length} changesets consumed.\n`);
  return version;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  validateStagedVersionCut();
}
