import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, test } from 'node:test';

interface ScriptUtilities {
  readonly electronTestEnvironment: (environment: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
  readonly unitTestExecutable: (platform?: NodeJS.Platform, nodeExecutable?: string) => string;
  readonly resolveRemoval: (root: string, candidate: string) => string;
  readonly assertPlatform: (
    expectedPlatform: string,
    expectedArchitecture: string,
    actual: { readonly platform: string; readonly arch: string },
  ) => void;
}

const root = process.cwd();
const { electronTestEnvironment, unitTestExecutable } = (await import(
  pathToFileURL(path.join(root, 'scripts/run-electron-node-test.mjs')).href
)) as Pick<ScriptUtilities, 'electronTestEnvironment' | 'unitTestExecutable'>;
const { resolveRemoval } = (await import(pathToFileURL(path.join(root, 'scripts/remove-paths.mjs')).href)) as Pick<
  ScriptUtilities,
  'resolveRemoval'
>;
const { assertPlatform } = (await import(pathToFileURL(path.join(root, 'scripts/assert-platform.mjs')).href)) as Pick<
  ScriptUtilities,
  'assertPlatform'
>;

describe('cross-platform test commands (#1083)', () => {
  test('cleanup accepts only repository-relative descendants', () => {
    const root = path.resolve('repository-root');
    assert.equal(resolveRemoval(root, 'dist'), path.join(root, 'dist'));
    assert.throws(() => resolveRemoval(root, ''), /must be relative/u);
    assert.throws(() => resolveRemoval(root, '..'), /escapes the repository/u);
    assert.throws(() => resolveRemoval(root, path.resolve(root, 'dist')), /must be relative/u);
  });

  test('Electron node tests receive the required environment without shell syntax', () => {
    assert.deepEqual(electronTestEnvironment({ SENTINEL: 'kept' }), {
      SENTINEL: 'kept',
      ELECTRON_RUN_AS_NODE: '1',
    });
    assert.equal(unitTestExecutable('linux', '/opt/node/bin/node'), '/opt/node/bin/node');
    assert.notEqual(unitTestExecutable('darwin', '/opt/node/bin/node'), '/opt/node/bin/node');
    assert.notEqual(unitTestExecutable('win32', '/opt/node/bin/node'), '/opt/node/bin/node');
  });

  test('native runner assertions fail closed on an emulated architecture', () => {
    assert.doesNotThrow(() => assertPlatform('win32', 'arm64', { platform: 'win32', arch: 'arm64' }));
    assert.throws(() => assertPlatform('win32', 'arm64', { platform: 'win32', arch: 'x64' }), /expected win32\/arm64/u);
  });

  test('dead-code analysis has explicit renderer entries on Windows', () => {
    const config = JSON.parse(readFileSync(path.join(root, 'knip.json'), 'utf8')) as { readonly entry: readonly string[] };
    assert.ok(config.entry.includes('src/renderer/src/main.tsx'));
    assert.ok(config.entry.includes('src/renderer/src/capture-frame.ts'));
  });

  test('Playwright builds through the Windows command interpreter', () => {
    const setup = readFileSync(path.join(root, 'tests/e2e/global-setup.ts'), 'utf8');
    assert.match(setup, /'cmd\.exe'/u);
    assert.match(setup, /'npm run build'/u);
    assert.doesNotMatch(setup, /'npm\.cmd'/u);
  });
});
