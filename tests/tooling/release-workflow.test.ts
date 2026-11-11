import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

describe('release workflow publication', () => {
  test('requires exact-commit CI and reviewed-PR evidence before packaging', () => {
    const workflow = readFileSync(join(process.cwd(), '.github/workflows/release.yml'), 'utf8');

    assert.match(workflow, /name: Verify release evidence/u);
    assert.match(workflow, /event=merge_group&head_sha=\$RELEASE_SHA/u);
    assert.match(workflow, /\.name == "Complete suite" and \.conclusion == "success"/u);
    assert.match(workflow, /\.state == "APPROVED"/u);
    assert.match(workflow, /needs: verify/u);
  });

  test('rejects real pending releases but permits empty governance changesets', () => {
    const workflow = readFileSync(join(process.cwd(), '.github/workflows/release.yml'), 'utf8');
    const evidenceIndex = workflow.indexOf('- name: Verify exact-commit');
    const installIndex = workflow.indexOf('- name: Install release verification dependencies');
    const semanticVerify = workflow.split('- name: Verify semantic changeset state')[1]?.split('\n  build:')[0] ?? '';

    assert.match(
      workflow,
      /uses: true-line\/trueline-agent-ci\/\.github\/actions\/bounded-command@8ec38da39c9b43af2181d1f5e5b7e09226c0bfad/u,
    );
    assert.match(workflow, /arguments-json: '\["ci","--ignore-scripts"\]'/u);
    assert.ok(evidenceIndex >= 0 && installIndex > evidenceIndex, 'release dependencies execute only after evidence verification');
    assert.match(semanticVerify, /npx changeset status --output/u);
    assert.match(semanticVerify, /\.releases\.length/u);
    assert.match(semanticVerify, /test "\$releases" -eq 0/u);
    assert.doesNotMatch(semanticVerify, /find \.changeset/u);
  });

  test('uploads files recursively instead of passing artifact directories to gh', () => {
    const workflow = readFileSync(join(process.cwd(), '.github/workflows/release.yml'), 'utf8');

    assert.match(workflow, /find dist -type f -print0/u);
    assert.match(workflow, /gh release upload "\$TAG" "\$\{asset_specs\[@\]\}"/u);
    assert.match(workflow, /gh release create "\$TAG" "\$\{asset_specs\[@\]\}"/u);
    assert.doesNotMatch(workflow, /gh release (?:create|upload)[^\n]*dist\/\*/u);
  });

  test('publishes a clean prerelease regardless of signing availability', () => {
    const workflow = readFileSync(join(process.cwd(), '.github/workflows/release.yml'), 'utf8');

    assert.match(workflow, /title="Overlook \$TAG"/u);
    assert.match(workflow, /gh release edit "\$TAG" --prerelease --title "\$title"/u);
    assert.match(workflow, /gh release create "\$TAG" "\$\{asset_specs\[@\]\}"\s+\\\s+--prerelease\s+\\\s+--verify-tag/u);
    assert.doesNotMatch(workflow, /unsigned dev build/u);
    assert.doesNotMatch(workflow, /--latest/u);
  });

  test('labels each clickable installer with its platform signing state', () => {
    const workflow = readFileSync(join(process.cwd(), '.github/workflows/release.yml'), 'utf8');

    assert.match(workflow, /MAC_SIGNED: \$\{\{ secrets\.CSC_LINK != '' && secrets\.APPLE_API_KEY != '' \}\}/u);
    assert.match(
      workflow,
      /WINDOWS_SIGNED: \$\{\{ secrets\.AZURE_TENANT_ID != '' && secrets\.AZURE_CLIENT_ID != '' && secrets\.AZURE_CLIENT_SECRET != '' \}\}/u,
    );
    assert.match(workflow, /\*\.dmg\|\*-mac\.zip\)/u);
    assert.match(workflow, /\*\.exe\)/u);
    assert.match(workflow, /asset_specs\+=\("\$asset#\$name \(\$status\)"\)/u);
  });

  test('reads release credentials from the protected release environment and mints the write token only for publish', () => {
    const workflow = readFileSync(join(process.cwd(), '.github/workflows/release.yml'), 'utf8');
    const publishJob = workflow.split('\n  publish:\n')[1] ?? '';
    const extractNotes = publishJob.indexOf('- name: Extract release notes from CHANGELOG');
    const requireCreds = publishJob.indexOf('- name: Require chores-dumb credentials');
    const mint = publishJob.indexOf('- name: Mint the chores-dumb token');
    const createRelease = publishJob.indexOf('- name: Create release');

    assert.match(publishJob, /^ {4}environment: release$/mu);
    assert.match(publishJob, /^ {4}permissions:\n {6}contents: read$/mu);
    assert.doesNotMatch(workflow, /^\s+contents: write$/mu);
    assert.match(publishJob, /persist-credentials: false/u);
    assert.match(
      publishJob,
      /HAS_CHORES_DUMB: \$\{\{ secrets\.CHORES_DUMB_CLIENT_ID != '' && secrets\.CHORES_DUMB_PRIVATE_KEY != '' \}\}/u,
    );
    assert.ok(extractNotes >= 0 && extractNotes < requireCreds && requireCreds < mint && mint < createRelease);
    assert.match(publishJob, /uses: actions\/create-github-app-token@[0-9a-f]{40}/u);
    assert.match(publishJob, /permission-contents: write/u);
    assert.match(publishJob, /GH_TOKEN: \$\{\{ steps\.chores\.outputs\.token \}\}/u);
    assert.doesNotMatch(publishJob, /GH_TOKEN: \$\{\{ github\.token \}\}/u);
  });
});
