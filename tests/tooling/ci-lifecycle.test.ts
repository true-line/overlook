import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

const root = process.cwd();
const aca = readFileSync(join(root, '.github/workflows/aca.yml'), 'utf8');
const autoUpdate = readFileSync(join(root, '.github/workflows/auto-update-prs.yml'), 'utf8');
const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
const codeql = readFileSync(join(root, '.github/workflows/codeql.yml'), 'utf8');
const closeLinkedIssues = readFileSync(join(root, '.github/workflows/close-linked-issues.yml'), 'utf8');
const packageWorkflow = readFileSync(join(root, '.github/workflows/package.yml'), 'utf8');
const perf = readFileSync(join(root, '.github/workflows/perf.yml'), 'utf8');
const release = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');
const versionCut = readFileSync(join(root, '.github/workflows/version-cut.yml'), 'utf8');
const identityPolicy = readFileSync(join(root, 'docs/CI-Identity-And-Tokens.md'), 'utf8');
const playwright = readFileSync(join(root, 'playwright.config.ts'), 'utf8');

describe('governed CI lifecycle (ENG-0004)', () => {
  test('uses only governed CI triggers and PR-scoped cancellation', () => {
    assert.match(ci, /^ {2}pull_request:$/mu);
    assert.match(ci, /types: \[opened, synchronize, reopened, ready_for_review\]/u);
    assert.match(ci, /^ {2}merge_group:\n {4}types: \[checks_requested\]$/mu);
    assert.match(ci, /^ {2}push:\n {4}branches: \[main\]$/mu);
    assert.match(ci, /^ {2}workflow_dispatch:$/mu);
    assert.doesNotMatch(ci, /^ {2}(?:pull_request_target|repository_dispatch|schedule):$/mu);
    assert.match(ci, /format\('pr-\{0\}', github\.event\.pull_request\.number\)/u);
    assert.match(ci, /cancel-in-progress: \$\{\{ github\.event_name != 'push' \}\}/u);
  });

  test('loads actor and fork enforcement from the reviewed immutable policy commit', () => {
    assert.match(ci, /uses: true-line\/trueline-agent-ci\/\.github\/actions\/ci-policy@8ec38da39c9b43af2181d1f5e5b7e09226c0bfad/u);
    assert.doesNotMatch(ci, /uses: \.\/\.github\/actions\/ci-policy/u);
    assert.match(ci, /github\.event\.pull_request\.draft == false/u);
  });

  test('documents the narrow native-queue exception and disabled preview policy', () => {
    assert.match(identityPolicy, /both actor fields to be `github-merge-queue\[bot\]`/u);
    assert.match(identityPolicy, /Workflow execution protections\*\* disabled/u);
    assert.match(identityPolicy, /never approve\s+external fork runs/u);
    assert.match(identityPolicy, /Bind\s+`CodeQL` to the GitHub Advanced Security App/u);
    assert.match(identityPolicy, /other four contexts\s+to GitHub Actions — never to `chores-dumb`/u);
    assert.match(identityPolicy, /only its stable `E2E gate` verdict belongs in branch protection/u);
  });

  test('authorizes every direct non-CI entrypoint before repository work', () => {
    const workflows = [aca, autoUpdate, packageWorkflow, perf, release, versionCut, closeLinkedIssues];
    for (const workflow of workflows) {
      assert.match(workflow, /^ {2}policy:$/mu);
      assert.match(workflow, /authorization-only: 'true'/u);
      assert.match(workflow, /ci-policy@8ec38da39c9b43af2181d1f5e5b7e09226c0bfad/u);
    }
    for (const [workflow, jobs] of [
      [autoUpdate, ['update']],
      [packageWorkflow, ['package']],
      [perf, ['perf']],
      [release, ['verify']],
      [versionCut, ['version-pr']],
      [closeLinkedIssues, ['close-linked-issues']],
    ] as const) {
      for (const job of jobs) assert.match(workflow, new RegExp(`^  ${job}:\\n {4}needs: policy`, 'mu'));
    }
    assert.match(versionCut, /^ {2}tag:\n {4}needs: \[policy, version-pr\]$/mu);
    assert.equal((aca.match(/github\.actor != 'dependabot\[bot\]'/gu) ?? []).length, 3);
    assert.equal((aca.match(/github\.event\.pull_request\.user\.login != 'dependabot\[bot\]'/gu) ?? []).length, 3);
  });

  test('reuses only exact-SHA complete-suite evidence', () => {
    assert.match(ci, /event=workflow_dispatch&head_sha=\$TARGET_SHA/u);
    assert.match(ci, /\.display_title == "CI workflow_dispatch purpose=exact-sha-preflight retries=0"/u);
    assert.match(ci, /event=merge_group&head_sha=\$GITHUB_SHA/u);
    assert.match(ci, /\.path == "\.github\/workflows\/ci\.yml"/u);
    assert.match(ci, /\.name == "CI" and \.conclusion == "success"/u);
    assert.match(ci, /needs\.preflight-evidence\.outputs\.validated != 'true'/u);
    assert.match(ci, /needs\.merge-evidence\.outputs\.validated != 'true'/u);
  });

  test('retains every agreed complete-suite command and stable gate', () => {
    for (const command of [
      'npm run check:interop-acceptance',
      'npm run lint',
      'npm run format:check',
      'npm run check:changesets',
      'npm run check:acceptance-coverage',
      'npm run check:a11y-budget',
      'npm run test:cov:inner',
      'npm run build',
      'npm run test:stories:ci:inner',
      'npm run test:e2e:inner',
    ]) {
      assert.match(ci, new RegExp(command, 'u'));
    }
    assert.match(ci, /name: Docs governance/u);
    assert.match(ci, /^ {2}e2e-gate:\n {4}name: E2E gate$/mu);
    assert.match(ci, /^ {2}gate:\n {4}name: CI$/mu);
    assert.match(ci, /git branch main origin\/main/u);
    assert.match(ci, /arguments-json: '\["ci"\]'/u);
    assert.match(ci, /arguments-json: '\["playwright","install","--with-deps","chromium"\]'/u);
  });

  test('requires native Windows import evidence at each lifecycle boundary (#1083)', () => {
    const gate = ci.slice(ci.indexOf('\n  gate:\n'));
    assert.match(ci, /^ {2}windows-tests:\n {4}name: Windows x64 tests and import$/mu);
    assert.match(ci, /runs-on: windows-latest/u);
    assert.match(ci, /name: Configure LF checkout\s+run: git config --global core\.autocrlf false/u);
    assert.match(ci, /executable: cmd\.exe/u);
    assert.match(ci, /run: npm run test:inner/u);
    assert.match(ci, /run: npm run test:e2e:windows-import:inner/u);
    assert.match(ci, /^ {2}windows-main-smoke:\n {4}name: Windows \$\{\{ matrix\.arch \}\} source import$/mu);
    assert.match(ci, /arch: arm64\s+runner: windows-11-arm/u);
    assert.match(ci, /node scripts\/assert-platform\.mjs win32 \$\{\{ matrix\.arch \}\}/u);
    assert.match(gate, /needs:[\s\S]{0,300}windows-tests,[\s\S]{0,100}windows-main-smoke,[\s\S]{0,300}post-merge,/u);
    assert.match(gate, /test "\$WINDOWS_TESTS" = success/u);
    assert.match(gate, /test "\$WINDOWS_MAIN" = success/u);
  });

  test('enforces finite workflow runtime with the reviewed immutable contract', () => {
    const sources = [aca, autoUpdate, ci, closeLinkedIssues, codeql, packageWorkflow, perf, release, versionCut].join('\n');
    assert.doesNotMatch(sources, /^\s*run: (?:npm (?:ci|install)|npm --prefix .* clean-install|npx playwright install)/gmu);
    assert.match(
      sources,
      /uses: true-line\/trueline-agent-ci\/\.github\/actions\/bounded-command@8ec38da39c9b43af2181d1f5e5b7e09226c0bfad/u,
    );
    assert.match(ci, /name: Workflow runtime policy/u);
    assert.match(ci, /ref: 8ec38da39c9b43af2181d1f5e5b7e09226c0bfad/u);
    assert.match(ci, /runtime-policy\.mjs --root "\$GITHUB_WORKSPACE"/u);
    assert.match(ci, /WORKFLOW_RUNTIME: \$\{\{ needs\.workflow-runtime\.result \}\}/u);
    assert.match(ci, /test "\$WORKFLOW_RUNTIME" = success/u);
  });

  test('keeps required E2E runs on the measured one-worker, zero-retry baseline (#897)', () => {
    assert.match(ci, /OVERLOOK_E2E_WORKERS: .*inputs\.e2e_workers \|\| '1'/u);
    assert.match(ci, /OVERLOOK_E2E_RETRIES: .*inputs\.e2e_retries \|\| '0'/u);
    assert.match(playwright, /workers: positiveInteger\('OVERLOOK_E2E_WORKERS', 1\)/u);
    assert.match(playwright, /retries: isCi \? positiveInteger\('OVERLOOK_E2E_RETRIES', 0\) : 0/u);
  });

  test('embeds the configured pCloud client ID in release package builds', () => {
    assert.match(packageWorkflow, /OVERLOOK_PCLOUD_CLIENT_ID: \$\{\{ secrets\.PCLOUD_CLIENT_ID \}\}/u);
  });

  test('runs advanced CodeQL for both existing languages through CI only', () => {
    assert.match(codeql, /^ {2}workflow_call:$/mu);
    assert.doesNotMatch(codeql, /^ {2}(?:pull_request|push|workflow_dispatch|schedule):$/mu);
    assert.match(codeql, /language: \[actions, javascript-typescript\]/u);
    assert.match(codeql, /security-events: write/u);
    assert.match(codeql, /github\/codeql-action\/init@1c5b675653bb5c22dbe9b12b556ec555138e09fd/u);
    assert.match(codeql, /github\/codeql-action\/analyze@1c5b675653bb5c22dbe9b12b556ec555138e09fd/u);
  });

  test('keeps main on smoke-or-complete fallback while CodeQL owns default-branch alerts', () => {
    assert.match(ci, /name: Post-merge smoke/u);
    assert.match(ci, /name: Interop integration smoke/u);
    assert.match(ci, /needs\.policy\.outputs\.run_post_merge == 'true' \|\|/u);
    assert.match(ci, /if \[ "\$MERGE_VALIDATED" = true \]; then[\s\S]*test "\$POST_MERGE" = success[\s\S]*else/u);
  });

  test('release publication fails closed on exact complete-suite and reviewed-PR evidence', () => {
    assert.match(release, /name: Verify release evidence/u);
    assert.match(release, /event=merge_group&head_sha=\$RELEASE_SHA/u);
    assert.match(release, /event=push&head_sha=\$RELEASE_SHA/u);
    assert.match(release, /\.name == "Complete suite" and \.conclusion == "success"/u);
    assert.match(release, /\.state == "APPROVED"/u);
    assert.match(release, /event=pull_request&head_sha=\$pr_head/u);
    assert.match(release, /needs: \[verify, build\]/u);
  });

  test('versioning dispatches no duplicate CI and the governed updater preserves freshness', () => {
    assert.doesNotMatch(versionCut, /gh workflow run ci\.yml/u);
    assert.match(versionCut, /event=push&head_sha=\$GITHUB_SHA/u);
    assert.equal(existsSync(join(root, '.github/workflows/auto-update-prs.yml')), true);
    assert.match(autoUpdate, /name: Require chores-dumb credentials/u);
    assert.match(
      autoUpdate,
      /HAS_CHORES_DUMB: \$\{\{ secrets\.CHORES_DUMB_CLIENT_ID != '' && secrets\.CHORES_DUMB_PRIVATE_KEY != '' \}\}/u,
    );
    assert.match(autoUpdate, /GH_TOKEN: \$\{\{ steps\.chores\.outputs\.token \}\}/u);
    assert.doesNotMatch(autoUpdate, /RELEASE_TOKEN|\|\| github\.token/u);
  });
});

// A workflow RUN's `.name` is its evaluated `run-name:`, not the workflow's
// `name:`. ci.yml carries a dynamic run-name, so every
// `workflow_runs[] | select(.name == "CI" ...)` silently matched nothing —
// which stranded the tag after v0.65.1 and failed release evidence for v0.65.3.
// Six selectors carried the bug; fixing them one at a time missed five, so this
// scans every workflow instead. `.path` is the stable identifier. Job-level
// `.name` checks are JOB names and are unaffected.
describe('workflow run selectors', () => {
  const workflows = readdirSync(join(root, '.github/workflows'))
    .filter((entry) => entry.endsWith('.yml') || entry.endsWith('.yaml'))
    .map((entry) => ({ entry, body: readFileSync(join(root, '.github/workflows', entry), 'utf8') }));

  // Scan each jq program whole rather than matching a `select(...)` predicate:
  // a `[^)]*` predicate match stops at the first `)`, so a nested group before
  // the clause (`select(.path == x and (.conclusion == "success") and .name ==
  // "CI")`) would slip through. jq programs here are single-quoted, so the slice
  // from `workflow_runs[]` to the next `'` is the rest of that program, and
  // spans continuation lines. `.jobs[]` programs are separate calls, so their
  // legitimate job-name checks never land in this slice.
  test('never identify a workflow run by .name', () => {
    assert.notEqual(workflows.length, 0);
    const selectsRunByName = (body: string): boolean =>
      body
        .split('workflow_runs[]')
        .slice(1)
        .some((rest) => /\.name\s*==/u.test(rest.split("'")[0] ?? ''));
    const offenders = workflows.filter(({ body }) => selectsRunByName(body)).map(({ entry }) => entry);

    assert.deepEqual(offenders, [], 'select workflow runs on .path — .name is the evaluated run-name');
  });
});
