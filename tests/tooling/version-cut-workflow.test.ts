import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

describe('version-cut workflow', () => {
  const workflow = readFileSync(join(process.cwd(), '.github/workflows/version-cut.yml'), 'utf8');

  test('uses chores-dumb for writes and GITHUB_TOKEN only for read-only evidence', () => {
    // The version PR is opened and force-refreshed by chores-dumb[bot] so it gets
    // real pull_request CI runs, and the tag is pushed with that token so
    // release.yml's on:push:tags trigger fires. GITHUB_TOKEN events start no
    // workflows at all, and github-actions[bot] is not an authorized actor here —
    // its runs fail at startup with "Actor is not allowed to trigger Actions
    // workflows". A bot rather than a human PAT also keeps the version PR
    // approvable: qwts cannot approve a PR qwts opened (ENG-0045 decision 4).
    assert.match(workflow, /uses: actions\/create-github-app-token@[0-9a-f]{40}/u);
    assert.equal(workflow.match(/GH_TOKEN: \$\{\{ steps\.chores\.outputs\.token \}\}/gu)?.length, 2);
    assert.equal(workflow.match(/GH_TOKEN: \$\{\{ github\.token \}\}/gu)?.length, 2);
    assert.equal(workflow.match(/\n {4}environment: version-cut\n/gu)?.length, 2);
    assert.match(workflow, /^ {2}actions: read$/mu);
    assert.doesNotMatch(workflow, /^\s+(?:actions|contents|pull-requests): write$/mu);
    assert.doesNotMatch(workflow, /RELEASE_TOKEN|\|\| github\.token/u);
    // The secrets context is unavailable in `if`, so presence is surfaced as env.
    assert.match(workflow, /HAS_CHORES_DUMB: \$\{\{ secrets\.CHORES_DUMB_CLIENT_ID != '' && secrets\.CHORES_DUMB_PRIVATE_KEY != '' \}\}/u);
  });

  test('fails closed when chores-dumb credentials are absent or unreadable', () => {
    const requirements = workflow.match(/- name: Require chores-dumb credentials/gu) ?? [];
    assert.equal(requirements.length, 2);

    const mints = workflow.split(/- name: Mint the chores-dumb token/u).slice(1);
    assert.equal(mints.length, 2);
    for (const mint of mints) {
      const beforeUses = mint.split('uses:')[0] ?? '';
      assert.match(beforeUses, /if: steps\.(?:version\.outputs\.ready == 'true'|release-plan\.outputs\.kind != 'none')/u);
      assert.doesNotMatch(beforeUses, /continue-on-error/u);
      assert.match(mint, /client-id: \$\{\{ secrets\.CHORES_DUMB_CLIENT_ID \}\}/u);
      assert.match(mint, /private-key: \$\{\{ secrets\.CHORES_DUMB_PRIVATE_KEY \}\}/u);
    }
  });

  test('never puts a repo credential in reach of a third-party action', () => {
    // The App key and the token it mints never go to a third-party action. The
    // token is minted by actions/create-github-app-token rather than a
    // third-party equivalent (AGENTS.md → Branch And GitHub Hygiene).
    const foreign = [...workflow.matchAll(/^\s*uses: (?<action>[^@\s]+)/gmu)]
      .map((match) => match.groups?.['action'] ?? '')
      .filter((action) => !action.startsWith('actions/') && action !== 'true-line/trueline-agent-ci/.github/actions/bounded-command');

    assert.deepEqual(foreign, []);
  });

  test('keeps repository credentials away from the changeset CLI', () => {
    const versionJob = workflow.split(/^ {2}tag:/mu)[0] ?? '';
    const versionStep =
      versionJob.split('- name: Create the Version packages commit')[1]?.split('- name: Require chores-dumb credentials')[0] ?? '';

    assert.match(versionJob, /persist-credentials: false/u);
    assert.match(versionStep, /git branch main origin\/main/u);
    assert.match(versionStep, /npx changeset status --output/u);
    assert.match(versionStep, /\.releases\.length/u);
    assert.match(versionStep, /cp scripts\/publish-signed-version-commit\.mjs "\$RUNNER_TEMP\/trusted-publish-version-commit\.mjs"/u);
    assert.match(versionStep, /npx changeset version/u);
    assert.ok(
      versionStep.indexOf('cp scripts/publish-signed-version-commit.mjs') < versionStep.indexOf('npx changeset version'),
      'the publisher must be preserved before changeset version runs',
    );
    assert.doesNotMatch(versionStep, /GH_TOKEN|RELEASE_TOKEN|steps\.chores\.outputs\.token/u);
    assert.match(versionJob, /if: steps\.version\.outputs\.ready == 'true'/u);
    assert.match(versionJob, /node "\$RUNNER_TEMP\/trusted-publish-version-commit\.mjs"/u);
    assert.doesNotMatch(versionJob, /push --force origin "\$BRANCH"/u);
  });

  test('does not open a version PR for empty governance changesets', () => {
    const versionJob = workflow.split(/^ {2}tag:/mu)[0] ?? '';
    const status = versionJob.indexOf('npx changeset status --output');
    const noReleaseExit = versionJob.indexOf('if [ "$releases" -eq 0 ]');
    const version = versionJob.indexOf('npx changeset version');

    assert.ok(status < noReleaseExit && noReleaseExit < version);
    assert.match(versionJob, /has-releases: \$\{\{ steps\.version\.outputs\.has-releases \}\}/u);
    assert.match(versionJob, /echo 'has-releases=false' >> "\$GITHUB_OUTPUT"/u);
    assert.match(versionJob, /echo 'has-releases=true' >> "\$GITHUB_OUTPUT"/u);
  });

  test('uses the semantic release count for tag planning so empty changesets permit recovery', () => {
    const tagJob = workflow.split(/^ {2}tag:/mu)[1] ?? '';

    assert.match(tagJob, /needs: \[policy, version-pr\]/u);
    assert.match(tagJob, /HAS_RELEASES: \$\{\{ needs\.version-pr\.outputs\.has-releases \}\}/u);
    assert.match(tagJob, /if \[ "\$HAS_RELEASES" = true \]/u);
    assert.doesNotMatch(tagJob, /find \.changeset/u);
  });

  test('mints the tag token only after the exact-SHA wait and only for a planned write', () => {
    const tagJob = workflow.split(/^ {2}tag:/mu)[1] ?? '';
    const plan = tagJob.indexOf('- name: Determine release operation');
    const wait = tagJob.indexOf('- name: Wait for exact main-push CI');
    const requireCredentials = tagJob.indexOf('- name: Require chores-dumb credentials');
    const mint = tagJob.indexOf('- name: Mint the chores-dumb token');
    const publish = tagJob.indexOf('- name: Publish tag or recover release');

    assert.ok(plan < wait && wait < requireCredentials && requireCredentials < mint && mint < publish);
    assert.match(tagJob, /if: steps\.release-plan\.outputs\.kind != 'none'/u);
    assert.match(tagJob, /persist-credentials: false/u);
  });

  test('hand-dispatches nothing but stranded-tag recovery', () => {
    // Replaces the old "dispatch version-branch checks only after Changesets
    // creates the PR" guard: that dispatch existed to work around GITHUB_TOKEN
    // events triggering nothing, and it is itself a bot action the actor policy
    // refuses. Only the recovery dispatch survives — an already-existing tag has
    // no push event left to replay.
    assert.doesNotMatch(workflow, /gh workflow run ci\.yml/u);
    assert.deepEqual(workflow.match(/gh workflow run \S+/gu), ['gh workflow run release.yml']);
  });

  test('waits for the exact main-push CI gate before tagging without dispatching another suite', () => {
    assert.match(workflow, /event=push&head_sha=\$GITHUB_SHA/u);
    assert.match(workflow, /\.name == "CI" and \.conclusion == "success"/u);
    assert.doesNotMatch(workflow, /gh workflow run ci\.yml/u);
  });
});

// A run's `.name` is its evaluated `run-name:`, so ci.yml's dynamic run-name
// makes `.name == "CI"` match nothing — it blocked every release after v0.65.1.
// Rationale in full at the wait step in version-cut.yml.
describe('version-cut exact-SHA CI run matching', () => {
  const workflow = readFileSync(join(process.cwd(), '.github/workflows/version-cut.yml'), 'utf8');

  test('identifies the run by workflow path, never by run name', () => {
    assert.match(workflow, /select\(\.path == "\.github\/workflows\/ci\.yml"\) \| \.id\)/u);
    assert.doesNotMatch(workflow, /workflow_runs\[\] \| select\(\.name/u);
  });
});
