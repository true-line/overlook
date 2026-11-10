#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const LOCAL_REPOSITORY = 'true-line/overlook';
const COMPANION_REPOSITORY = 'true-line/image-trail';
const COMPANION_COMMIT = 'cf3fe884c7729db73cfe0ddb7c90be6c4d881c09';
const MANIFEST_PATH = 'design/handoff/contracts/v1/acceptance-evidence.json';
const REPOSITORIES = new Set(['true-line/image-trail', 'true-line/overlook']);
const EXPECTED_SCENARIOS = new Set([
  'move-overlook-to-image-trail',
  'move-image-trail-to-overlook',
  'metadata-duplicates-conflicts-and-round-trip',
  'deterministic-reviewed-sync',
  'interruption-and-idempotent-recovery',
  'provider-success-and-failure-vocabulary',
  'provider-and-product-namespace-isolation',
  'encrypted-envelope-and-pairing-fail-closed',
  'album-provenance-and-ui-stability',
  'privacy-security-and-release-packaging',
]);
const EXPECTED_MANUAL_CHECKS = new Set([
  'released-products-bidirectional',
  'live-pcloud',
  'live-google-drive',
  'signed-icloud-native-host',
]);

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function arrayOfStrings(value) {
  return Array.isArray(value) && value.length > 0 && value.every(nonEmptyString);
}

function safeRelativePath(value) {
  if (!nonEmptyString(value) || path.isAbsolute(value)) return false;
  const normalized = path.normalize(value);
  return normalized !== '..' && !normalized.startsWith(`..${path.sep}`);
}

function checkExactIds(entries, expected, label, failures) {
  const ids = new Set();
  for (const [index, entry] of entries.entries()) {
    const id = entry?.id;
    if (!nonEmptyString(id)) {
      failures.push(`${label}[${index}] requires a non-empty id.`);
      continue;
    }
    if (ids.has(id)) failures.push(`${label} contains duplicate id ${id}.`);
    ids.add(id);
  }
  for (const id of expected) if (!ids.has(id)) failures.push(`${label} is missing ${id}.`);
  for (const id of ids) if (!expected.has(id)) failures.push(`${label} contains unexpected id ${id}.`);
}

function resolveRepositoryRoots(rootDirectory, failures) {
  const companionDirectory = process.env['INTEROP_IMAGE_TRAIL_ROOT'];
  if (!nonEmptyString(companionDirectory)) {
    failures.push('INTEROP_IMAGE_TRAIL_ROOT must point to the pinned Image Trail evidence checkout.');
    return new Map([[LOCAL_REPOSITORY, rootDirectory]]);
  }

  const companionRoot = path.resolve(companionDirectory);
  try {
    const revision = execFileSync('git', ['-C', companionRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    if (revision !== COMPANION_COMMIT) {
      failures.push(`${COMPANION_REPOSITORY} evidence checkout must be pinned to ${COMPANION_COMMIT}; found ${revision}.`);
    }
  } catch {
    failures.push(`Unable to read the ${COMPANION_REPOSITORY} evidence checkout at ${companionRoot}.`);
  }

  return new Map([
    [LOCAL_REPOSITORY, rootDirectory],
    [COMPANION_REPOSITORY, companionRoot],
  ]);
}

async function validateEvidence(evidence, scenarioId, repositoryRoots, failures) {
  if (!Array.isArray(evidence) || evidence.length === 0) {
    failures.push(`${scenarioId}: evidence must be a non-empty array.`);
    return;
  }

  const represented = new Set();
  for (const [index, item] of evidence.entries()) {
    const label = `${scenarioId}.evidence[${index}]`;
    if (!REPOSITORIES.has(item?.repository)) {
      failures.push(`${label}: unsupported repository ${String(item?.repository)}.`);
      continue;
    }
    if (!safeRelativePath(item.path)) failures.push(`${label}: path must be repository-relative and traversal-free.`);
    if (!nonEmptyString(item.contains)) failures.push(`${label}: contains must name stable test evidence.`);
    if (!safeRelativePath(item.path) || !nonEmptyString(item.contains)) continue;

    const repositoryRoot = repositoryRoots.get(item.repository);
    if (!repositoryRoot) continue;

    try {
      const source = await readFile(path.resolve(repositoryRoot, item.path), 'utf8');
      if (!source.includes(item.contains)) failures.push(`${label}: ${item.path} no longer contains ${JSON.stringify(item.contains)}.`);
      else represented.add(item.repository);
    } catch (error) {
      if (error?.code === 'ENOENT') failures.push(`${label}: evidence path does not exist: ${item.path}.`);
      else throw error;
    }
  }
  for (const repository of REPOSITORIES) {
    if (!represented.has(repository)) failures.push(`${scenarioId}: evidence is missing ${repository}.`);
  }
}

function validateManualCheck(check, requireManual, failures) {
  const label = nonEmptyString(check?.id) ? check.id : 'manual check';
  if (!['pending', 'verified'].includes(check?.status)) failures.push(`${label}: status must be pending or verified.`);
  if (!nonEmptyString(check?.runbook) || !check.runbook.startsWith('https://github.com/true-line/')) {
    failures.push(`${label}: runbook must be a true-line GitHub URL.`);
  }
  if (check?.status === 'verified') {
    if (!nonEmptyString(check?.evidence?.url) || !check.evidence.url.startsWith('https://github.com/true-line/')) {
      failures.push(`${label}: verified evidence requires a true-line GitHub URL.`);
    }
    if (!nonEmptyString(check?.evidence?.runAt) || Number.isNaN(Date.parse(check.evidence.runAt))) {
      failures.push(`${label}: verified evidence requires an ISO runAt timestamp.`);
    }
  } else if (check?.evidence !== null) {
    failures.push(`${label}: pending evidence must be null.`);
  }
  if (requireManual && check?.status !== 'verified') failures.push(`${label}: manual closeout evidence is still pending.`);
}

export async function verifyInteropAcceptance(options = {}) {
  const rootDirectory = path.resolve(options.rootDirectory ?? process.cwd());
  const requireManual = options.requireManual ?? false;
  const manifestPath = path.resolve(rootDirectory, options.manifestPath ?? MANIFEST_PATH);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const failures = [];
  const repositoryRoots = resolveRepositoryRoots(rootDirectory, failures);

  if (manifest.schemaVersion !== 1) failures.push('schemaVersion must be 1.');
  if (manifest.contractVersion !== 1) failures.push('contractVersion must be 1.');
  if (manifest.canonicalRepository !== 'true-line/overlook') failures.push('canonicalRepository must be true-line/overlook.');
  if (
    !arrayOfStrings(manifest.parentIssues) ||
    !manifest.parentIssues.includes('true-line/image-trail#560') ||
    !manifest.parentIssues.includes('true-line/overlook#283')
  ) {
    failures.push('parentIssues must name both companion epics.');
  }

  const scenarios = Array.isArray(manifest.scenarios) ? manifest.scenarios : [];
  if (!Array.isArray(manifest.scenarios)) failures.push('scenarios must be an array.');
  checkExactIds(scenarios, EXPECTED_SCENARIOS, 'scenarios', failures);
  for (const scenario of scenarios) {
    const label = nonEmptyString(scenario?.id) ? scenario.id : 'scenario';
    if (!arrayOfStrings(scenario?.parentScenarios)) failures.push(`${label}: parentScenarios must be non-empty strings.`);
    if (!arrayOfStrings(scenario?.requirements)) failures.push(`${label}: requirements must be non-empty strings.`);
    await validateEvidence(scenario?.evidence, label, repositoryRoots, failures);
  }

  const manualChecks = Array.isArray(manifest.manualChecks) ? manifest.manualChecks : [];
  if (!Array.isArray(manifest.manualChecks)) failures.push('manualChecks must be an array.');
  checkExactIds(manualChecks, EXPECTED_MANUAL_CHECKS, 'manualChecks', failures);
  for (const check of manualChecks) validateManualCheck(check, requireManual, failures);

  if (failures.length > 0) throw new Error(`Interop acceptance evidence failed:\n- ${failures.join('\n- ')}`);
  return {
    scenarios: scenarios.length,
    automatedEvidence: scenarios.flatMap((scenario) => scenario.evidence).length,
    manualVerified: manualChecks.filter((check) => check.status === 'verified').length,
    manualTotal: manualChecks.length,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await verifyInteropAcceptance({ requireManual: process.argv.includes('--require-manual') });
  console.log(
    `Verified ${result.scenarios} interop scenarios with ${result.automatedEvidence} automated evidence references; manual ${result.manualVerified}/${result.manualTotal}.`,
  );
}
