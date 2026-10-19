import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

const dependabot = readFileSync(join(process.cwd(), '.github/dependabot.yml'), 'utf8');

function groupBody(name: string): string {
  const marker = `      ${name}:\n`;
  const start = dependabot.indexOf(marker);
  assert.ok(start >= 0, `missing Dependabot group: ${name}`);

  const remainder = dependabot.slice(start + marker.length);
  const nextGroup = remainder.search(/\n {6}[a-z][a-z0-9-]*:\n/u);
  return nextGroup >= 0 ? remainder.slice(0, nextGroup) : remainder;
}

describe('Dependabot update isolation (#1018, #1038)', () => {
  test('routes native database and macOS signing updates before the catch-all', () => {
    const catchAll = dependabot.indexOf('      dev-tooling:\n');
    assert.ok(catchAll >= 0);

    for (const group of ['native-database', 'macos-signing']) {
      const start = dependabot.indexOf(`      ${group}:\n`);
      assert.ok(start >= 0 && start < catchAll, `${group} must precede dev-tooling`);
    }
  });

  test('restricts the risky package groups to major updates', () => {
    for (const group of ['native-database', 'macos-signing']) {
      assert.match(groupBody(group), /update-types:\n {10}- 'major'/u);
    }
  });

  test('keeps the risky packages out of the low-risk wildcard group', () => {
    assert.match(groupBody('native-database'), /- 'better-sqlite3-multiple-ciphers'/u);
    assert.match(groupBody('macos-signing'), /- '@electron\/osx-sign'/u);
    assert.match(groupBody('dev-tooling'), /- '\*'/u);
  });

  test('excludes only the governed CI policy from action automation', () => {
    const githubActionsStart = dependabot.indexOf('  - package-ecosystem: github-actions\n');
    assert.ok(githubActionsStart >= 0);
    const githubActions = dependabot.slice(githubActionsStart);

    assert.match(githubActions, /dependency-name: 'true-line\?/trueline-agent-ci\/\.github\/actions\/ci-policy'/u);
    assert.doesNotMatch(githubActions, /dependency-name: 'true-line\?/trueline-agent-ci\/\.github\/actions\/bounded-command'/u);
  });
});
