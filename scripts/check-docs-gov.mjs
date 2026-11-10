#!/usr/bin/env node

// Local half of the documentation-governance gate (docs-gov, ENG-0009).
//
// CI runs docs-gov through the reusable workflow
// `true-line/trueline-agent-docs-gov/.github/workflows/docs-governance.yml@67db7dc9c20bc29222fb605b7ff9432fd58a2a3f`,
// which fetches the check implementation fresh at that same commit (its
// `tooling-ref` input). There is no npm dependency to vendor it, so this
// wrapper lets `npm run ci` / `/check` run the exact same check locally: point
// DOCS_GOV_TOOLING_ROOT at a true-line/trueline-agent-docs-gov checkout and it invokes
// that repo's CLI against photos' docs-gov.config.json. Same
// env-gated-external-checkout shape as check-interop-acceptance.mjs (see
// AGENTS.md → Documentation And Validation).

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const PLAYBOOK_REPOSITORY = 'true-line/trueline-agent-docs-gov';
// Must match the commit the reusable workflow is pinned to in ci.yml (and
// passes as `tooling-ref`), so a local pass proves the same thing a CI pass does.
const TOOLING_REF = '67db7dc9c20bc29222fb605b7ff9432fd58a2a3f';
const CLI_RELATIVE = 'tools/docs-gov/docs-gov.mjs';
const TOOLING_PATH = 'tools/docs-gov';

export function resolveToolingCli() {
  const failures = [];
  const toolingRoot = process.env['DOCS_GOV_TOOLING_ROOT'];
  if (typeof toolingRoot !== 'string' || toolingRoot.trim().length === 0) {
    failures.push(`DOCS_GOV_TOOLING_ROOT must point to a ${PLAYBOOK_REPOSITORY} checkout that has the ${TOOLING_REF} docs-gov tooling.`);
    return { cli: null, failures };
  }

  const root = path.resolve(toolingRoot);
  const cli = path.join(root, CLI_RELATIVE);
  if (!existsSync(cli)) {
    failures.push(`docs-gov CLI not found at ${cli} — is DOCS_GOV_TOOLING_ROOT a ${PLAYBOOK_REPOSITORY} checkout?`);
    return { cli: null, failures };
  }

  // Prove the checkout's tooling is byte-identical to the pinned commit, without
  // forcing the clone's HEAD onto it (it may be used for other work). The
  // working tree of tools/docs-gov must match that commit exactly.
  try {
    execFileSync('git', ['-C', root, 'rev-parse', '--verify', `${TOOLING_REF}^{commit}`], { stdio: 'pipe' });
  } catch {
    failures.push(`${PLAYBOOK_REPOSITORY} checkout at ${root} has no ${TOOLING_REF} commit — fetch it (git fetch origin).`);
    return { cli: null, failures };
  }
  const diff = spawnSync('git', ['-C', root, 'diff', '--quiet', TOOLING_REF, '--', TOOLING_PATH], { stdio: 'pipe' });
  if (diff.status !== 0) {
    failures.push(
      `${PLAYBOOK_REPOSITORY} checkout's ${TOOLING_PATH} differs from the ${TOOLING_REF} commit CI pins — check out ${TOOLING_REF} there, or the local gate would not match CI.`,
    );
    return { cli: null, failures };
  }

  return { cli, failures };
}

export function runDocsGov(options = {}) {
  const repoRoot = path.resolve(options.rootDirectory ?? process.cwd());
  const configPath = options.config ?? 'docs-gov.config.json';
  const { cli, failures } = resolveToolingCli();
  if (failures.length > 0) {
    throw new Error(`docs-gov gate is not runnable locally:\n- ${failures.join('\n- ')}`);
  }
  const result = spawnSync('node', [cli, '--root', repoRoot, '--config', configPath], { stdio: 'inherit' });
  if (result.status !== 0) {
    const detail = result.error ? `: ${result.error.message}` : '';
    throw new Error(`docs-gov reported findings (exit ${result.status})${detail}.`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runDocsGov();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
