import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

const root = process.cwd();

function readText(relPath: string): string {
  return readFileSync(join(root, relPath), 'utf8');
}

function readJson(relPath: string): Record<string, unknown> {
  return JSON.parse(readText(relPath)) as Record<string, unknown>;
}

describe('native extension and packaging contracts (#1440)', () => {
  test('windows-interop install.cjs resolves node-gyp through Node module resolution instead of local node_modules', () => {
    const installScript = readText('native/windows-interop/install.cjs');
    assert.match(installScript, /require\.resolve\('node-gyp\/bin\/node-gyp\.js'\)/u);
    assert.doesNotMatch(installScript, /join\(__dirname,\s*'node_modules',\s*'node-gyp'/u);
  });

  test('File Provider and PhotoKit clean up staged temporary files on error or cancellation', () => {
    const fileProvider = readText('native/file-provider-extension/OverlookFileProvider.m');
    assert.match(
      fileProvider,
      /if\s*\(itemError\s*!=\s*nil\s*\|\|\s*progress\.cancelled\)\s*\{\s*\[NSFileManager\.defaultManager removeItemAtURL:destination error:nil\];/u,
    );
    assert.match(fileProvider, /\[itemProgress cancel\];/u);

    const photokit = readText('native/touch-id/photokit.mm');
    assert.match(photokit, /auto cleanupStaged = \[&\]\(\)/u);
    assert.match(
      photokit,
      /for \(const AssetRecord& staged : output_\)\s*\{\s*\[files removeItemAtPath:String\(staged\.path\) error:nil\];/u,
    );
  });

  test('native_drag.mm rejects embedded NUL bytes, traversal segments, colons, and path separators', () => {
    const nativeDrag = readText('native/touch-id/native_drag.mm');
    assert.match(nativeDrag, /rawName\.find\('\\0'\)\s*!=\s*std::string::npos/u);
    assert.match(nativeDrag, /\[name containsString:@":"\]/u);
    assert.match(nativeDrag, /\[name containsString:@"\\\\"\]/u);
    assert.match(nativeDrag, /\[name containsString:@"\.\."\]/u);
  });

  test('electron-builder.yml excludes binding.gyp and test*.cjs from shipped @overlook native packages', () => {
    const builder = readText('electron-builder.yml');
    for (const pattern of [
      '!node_modules/@overlook/touch-id/binding.gyp',
      '!node_modules/@overlook/touch-id/test*.cjs',
      '!node_modules/@overlook/windows-interop/binding.gyp',
      '!node_modules/@overlook/windows-interop/test*.cjs',
    ]) {
      assert.ok(builder.includes(pattern), `electron-builder.yml must exclude ${pattern}`);
    }
  });

  test('package.json allowScripts stays synchronized with package-lock.json registry install scripts and file:native/* targets', () => {
    const manifest = readJson('package.json');
    const allowScripts = manifest['allowScripts'] as Record<string, boolean>;
    const devDeps = manifest['devDependencies'] as Record<string, string>;
    const lock = readJson('package-lock.json');
    const packages = lock['packages'] as Record<string, Record<string, unknown>>;

    assert.equal(allowScripts['file:native/touch-id'], true);
    assert.equal(allowScripts['file:native/windows-interop'], true);
    assert.equal(allowScripts['better-sqlite3-multiple-ciphers'], false);
    assert.equal(allowScripts[`electron@${devDeps['electron'] ?? ''}`], true);

    for (const [pkgPath, entry] of Object.entries(packages)) {
      if (pkgPath === '' || !pkgPath.startsWith('node_modules/')) continue;
      if (entry['hasInstallScript'] !== true) continue;
      const resolved = typeof entry['resolved'] === 'string' ? entry['resolved'] : '';
      if (!resolved.startsWith('https://registry.npmjs.org/')) continue;
      const lastNodeModules = pkgPath.lastIndexOf('node_modules/');
      const pkgName = pkgPath.slice(lastNodeModules + 'node_modules/'.length);
      const version = String(entry['version'] ?? '');
      assert.ok(
        allowScripts[`${pkgName}@${version}`] === true || allowScripts[pkgName] === false,
        `locked install-script package ${pkgName}@${version} (${pkgPath}) must have an explicit allowScripts decision`,
      );
    }

    for (const [key, allowed] of Object.entries(allowScripts)) {
      if (!allowed || key.startsWith('file:')) continue;
      const at = key.lastIndexOf('@');
      assert.ok(at > 0, `approved registry allowScripts entry ${key} must be version-pinned`);
      const name = key.slice(0, at);
      const version = key.slice(at + 1);
      const matchesLock = Object.entries(packages).some(([pkgPath, entry]) => {
        if (!pkgPath.startsWith('node_modules/')) return false;
        const lastNodeModules = pkgPath.lastIndexOf('node_modules/');
        const pkgName = pkgPath.slice(lastNodeModules + 'node_modules/'.length);
        return pkgName === name && entry['version'] === version;
      });
      assert.equal(matchesLock, true, `allowScripts entry ${key} does not match any locked package version`);
    }
  });
});
