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

    assert.match(workflow, /uses: qwts\/qwts-agent-ci\/\.github\/actions\/bounded-command@87c6b301057992f79a723f63c64624bf40c9d06a/u);
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
    assert.match(workflow, /gh release create "\$TAG" "\$\{asset_specs\[@\]\}"\s+\\\s+--prerelease/u);
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
});
