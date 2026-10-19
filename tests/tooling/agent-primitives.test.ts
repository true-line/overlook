import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';

import type { evaluateAgentContext as EvaluateAgentContext, paragraphs as Paragraphs } from '../../scripts/check-agent-context.mjs';

const root = process.cwd();

interface AgentContextModule {
  readonly paragraphs: typeof Paragraphs;
  readonly evaluateAgentContext: typeof EvaluateAgentContext;
}

function agentContextModule(): Promise<AgentContextModule> {
  return import(pathToFileURL(join(root, 'scripts/check-agent-context.mjs')).href) as Promise<AgentContextModule>;
}

function source(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

// #718 / ENG-0006: agent primitives are code and get the same review-as-code
// treatment. Harness adapters and settings were removed (qwts/qwts-agent-sop#89);
// AGENTS.md is the only agent context, and this contract keeps them out.
describe('agent primitives (#718, ENG-0006)', () => {
  test('harness adapters and settings stay removed', () => {
    for (const path of [
      'CLAUDE.md',
      '.github/copilot-instructions.md',
      '.claude/settings.json',
      '.claude/commands/check.md',
      '.claude/launch.json',
      '.codex/config.toml',
      '.codex/environments/environment.toml',
      '.codex/hooks.json',
      '.codex/rules/environment.rules',
      '.cursor/hooks.json',
      '.cursor/rules/process-guard.mdc',
      '.windsurf/hooks.json',
    ]) {
      assert.throws(() => source(path), `${path} must not exist: AGENTS.md is the only agent context`);
    }
  });

  test('a copied list item is caught, not hidden inside its list (PR #863 review)', async () => {
    const { evaluateAgentContext, paragraphs } = await agentContextModule();

    const bullet =
      '- Native menus, shortcuts, context menus, toolbars, and Quick Actions may show different subsets, but must not ' +
      'duplicate command identity, labels, enablement policy, shortcuts, or execution paths.';
    const list = `## Guard\n\n- A short first bullet that is on its own too brief to count.\n${bullet}\n- A short trailing bullet.\n`;

    // Each bullet is its own unit; the list is never one blob.
    assert.ok(paragraphs(list).some((unit) => unit.includes('native menus')));

    const failures = evaluateAgentContext({
      readText: (file) => (file === 'AGENTS.md' ? list : `See AGENTS.md.\n\n${bullet}\n`),
      readDir: () => [],
    });
    assert.ok(
      failures.some((failure) => failure.includes('CLAUDE.md') && failure.includes('repeats')),
      `expected the copied bullet to be reported, got: ${JSON.stringify(failures)}`,
    );
  });
});
