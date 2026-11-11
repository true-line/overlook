import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

describe('version-cut workflow', () => {
  const workflow = readFileSync(join(process.cwd(), '.github/workflows/version-cut.yml'), 'utf8');
  const prepareJob = workflow.split(/^ {2}prepare-version-pr:/mu)[1]?.split(/^ {2}publish-version-pr:/mu)[0] ?? '';
  const publishJob = workflow.split(/^ {2}publish-version-pr:/mu)[1]?.split(/^ {2}tag:/mu)[0] ?? '';
  const tagJob = workflow.split(/^ {2}tag:/mu)[1] ?? '';

  test('uses default-branch-only repository_dispatch for manual recovery', () => {
    assert.match(workflow, /^ {2}repository_dispatch:\n {4}types:\n {6}- version-cut-recovery$/mu);
    assert.doesNotMatch(workflow, /^\s*workflow_dispatch:/mu);
  });

  test('uses chores-dumb for writes and GITHUB_TOKEN only for read-only evidence', () => {
    assert.match(workflow, /uses: actions\/create-github-app-token@[0-9a-f]{40}/u);
    assert.equal(workflow.match(/GH_TOKEN: \$\{\{ steps\.chores\.outputs\.token \}\}/gu)?.length, 4);
    assert.equal(workflow.match(/GH_TOKEN: \$\{\{ github\.token \}\}/gu)?.length, 2);
    assert.equal(workflow.match(/\n {4}environment: version-cut\n/gu)?.length, 2);
    assert.doesNotMatch(prepareJob, /environment:/u);
    assert.match(publishJob, /^ {4}environment: version-cut$/mu);
    assert.match(tagJob, /^ {4}environment: version-cut$/mu);
    assert.match(workflow, /^ {2}actions: read$/mu);
    assert.doesNotMatch(workflow, /^\s+(?:actions|contents|pull-requests): write$/mu);
    assert.doesNotMatch(workflow, /RELEASE_TOKEN|\|\| github\.token/u);
    assert.match(workflow, /HAS_CHORES_DUMB: \$\{\{ secrets\.CHORES_DUMB_CLIENT_ID != '' && secrets\.CHORES_DUMB_PRIVATE_KEY != '' \}\}/u);
  });

  test('fails closed when chores-dumb credentials are absent and scopes minted App permissions', () => {
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

    assert.match(publishJob, /permission-contents: write\n\s+permission-pull-requests: write/u);
    assert.doesNotMatch(publishJob, /permission-actions: write/u);
    assert.match(tagJob, /permission-contents: write\n\s+permission-actions: write/u);
    assert.doesNotMatch(tagJob, /permission-pull-requests: write/u);
  });

  test('never puts a repo credential in reach of a third-party action', () => {
    const foreign = [...workflow.matchAll(/^\s*uses: (?<action>[^@\s]+)/gmu)]
      .map((match) => match.groups?.['action'] ?? '')
      .filter(
        (action) =>
          !action.startsWith('actions/') &&
          action !== 'true-line/trueline-agent-ci/.github/actions/ci-policy' &&
          action !== 'true-line/trueline-agent-ci/.github/actions/bounded-command',
      );

    assert.deepEqual(foreign, []);
  });

  test('isolates dependency installation and changeset execution from the credentialed publish runner', () => {
    assert.match(prepareJob, /persist-credentials: false/u);
    assert.match(prepareJob, /git branch main origin\/main/u);
    assert.match(prepareJob, /npx changeset status --output/u);
    assert.match(prepareJob, /npm run changeset:version/u);
    assert.match(prepareJob, /node scripts\/validate-version-cut\.mjs/u);
    assert.match(prepareJob, /git diff --cached --binary --full-index --no-renames HEAD > "\$RUNNER_TEMP\/version\.patch"/u);
    assert.doesNotMatch(prepareJob, /GH_TOKEN|CHORES_DUMB|steps\.chores\.outputs\.token/u);

    const applyStep =
      publishJob.split('- name: Apply and validate the version patch')[1]?.split('- name: Require chores-dumb credentials')[0] ?? '';
    assert.doesNotMatch(publishJob, /bounded-command|npm ci|npm install|npx changeset|npm run changeset/u);
    assert.match(publishJob, /if: needs\.policy\.result == 'success' && needs\.prepare-version-pr\.outputs\.ready == 'true'/u);
    assert.match(publishJob, /persist-credentials: false/u);
    assert.match(applyStep, /cp scripts\/validate-version-cut\.mjs "\$trusted_validator"/u);
    assert.match(applyStep, /cp scripts\/publish-signed-version-commit\.mjs "\$RUNNER_TEMP\/trusted-publish-version-commit\.mjs"/u);
    assert.ok(
      applyStep.indexOf('cp scripts/validate-version-cut.mjs') < applyStep.indexOf('git apply --index') &&
        applyStep.indexOf('cp scripts/publish-signed-version-commit.mjs') < applyStep.indexOf('git apply --index'),
      'both first-party scripts must be preserved from the trusted base before applying the patch',
    );
    assert.match(applyStep, /node "\$trusted_validator"/u);
    assert.match(applyStep, /git -c core\.hooksPath=\/dev\/null -c commit\.gpgsign=false commit -m 'Version packages'/u);
    assert.doesNotMatch(applyStep, /GH_TOKEN|RELEASE_TOKEN|steps\.chores\.outputs\.token/u);
    assert.match(publishJob, /-f head="\$GITHUB_REPOSITORY_OWNER:\$BRANCH"/u);
    assert.match(publishJob, /Refusing to refresh \$\{#open_prs\[@\]\} open PRs/u);
    assert.match(publishJob, /node "\$RUNNER_TEMP\/trusted-publish-version-commit\.mjs"/u);
    assert.doesNotMatch(publishJob, /push --force origin "\$BRANCH"/u);
  });

  test('does not open a version PR for empty governance changesets', () => {
    const status = prepareJob.indexOf('npx changeset status --output');
    const noReleaseExit = prepareJob.indexOf('if [ "$releases" -eq 0 ]');
    const version = prepareJob.indexOf('npm run changeset:version');

    assert.ok(status >= 0 && status < noReleaseExit && noReleaseExit < version);
    assert.match(prepareJob, /has-releases: \$\{\{ steps\.version\.outputs\.has-releases \}\}/u);
    assert.match(prepareJob, /echo 'has-releases=false' >> "\$GITHUB_OUTPUT"/u);
    assert.match(prepareJob, /echo 'has-releases=true' >> "\$GITHUB_OUTPUT"/u);
  });

  test('uses the semantic release count and synchronized lockfile check for tag planning', () => {
    assert.match(tagJob, /needs: \[policy, prepare-version-pr\]/u);
    assert.match(tagJob, /if: needs\.policy\.result == 'success' && needs\.prepare-version-pr\.outputs\.should-check-tag == 'true'/u);
    assert.match(tagJob, /HAS_RELEASES: \$\{\{ needs\.prepare-version-pr\.outputs\.has-releases \}\}/u);
    assert.match(tagJob, /if \[ "\$HAS_RELEASES" = true \]/u);
    assert.match(tagJob, /package and lockfile versions are not synchronized/u);
    assert.doesNotMatch(tagJob, /find \.changeset/u);
  });

  test('mints the tag token only after the exact-SHA wait and only for a planned write', () => {
    const plan = tagJob.indexOf('- name: Determine release operation');
    const wait = tagJob.indexOf('- name: Wait for exact main-push CI');
    const requireCredentials = tagJob.indexOf('- name: Require chores-dumb credentials');
    const mint = tagJob.indexOf('- name: Mint the chores-dumb token');
    const publish = tagJob.indexOf('- name: Publish tag or recover release');

    assert.ok(plan >= 0 && plan < wait && wait < requireCredentials && requireCredentials < mint && mint < publish);
    assert.match(tagJob, /if: steps\.release-plan\.outputs\.kind != 'none'/u);
    assert.match(tagJob, /persist-credentials: false/u);
  });

  test('hand-dispatches nothing but stranded-tag recovery', () => {
    assert.doesNotMatch(workflow, /gh workflow run ci\.yml/u);
    assert.deepEqual(workflow.match(/gh workflow run \S+/gu), ['gh workflow run release.yml']);
  });

  test('waits for the exact main-push CI gate before tagging without dispatching another suite', () => {
    assert.match(workflow, /event=push&head_sha=\$GITHUB_SHA/u);
    assert.match(workflow, /\.name == "CI" and \.conclusion == "success"/u);
    assert.doesNotMatch(workflow, /gh workflow run ci\.yml/u);
  });
});

describe('version-cut exact-SHA CI run matching', () => {
  const workflow = readFileSync(join(process.cwd(), '.github/workflows/version-cut.yml'), 'utf8');

  test('identifies the run by workflow path, never by run name', () => {
    assert.match(workflow, /select\(\.path == "\.github\/workflows\/ci\.yml"\) \| \.id\)/u);
    assert.doesNotMatch(workflow, /workflow_runs\[\] \| select\(\.name/u);
  });
});
