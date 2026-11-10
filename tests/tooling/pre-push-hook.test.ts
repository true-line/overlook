import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

describe('pre-push lint gate (#767)', () => {
  test('uses the same lint entrypoint as hosted CI', () => {
    const hook = readFileSync('.husky/pre-push', 'utf8').trim();
    const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { readonly scripts?: Record<string, string> };
    const lintCommand = packageJson.scripts?.['lint'] ?? '';

    assert.equal(hook, 'npm run lint && npm run format:check');
    assert.match(workflow, /^\s*run: npm run lint$/mu);
    assert.match(workflow, /^\s*run: npm run format:check$/mu);
    assert.match(lintCommand, /npm run lint:new-files/u);
    assert.match(lintCommand, /eslint \./u);
  });
});
