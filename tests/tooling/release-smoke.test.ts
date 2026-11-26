import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import {
  RELEASE_IMPORT_SMOKE_ARGUMENT,
  RELEASE_IMPORT_SMOKE_ERROR_MARKER,
  RELEASE_IMPORT_SMOKE_READY_MARKER,
  RELEASE_SMOKE_ARGUMENT,
  RELEASE_SMOKE_READY_MARKER,
  exitForReleaseSmokeIfRequested,
  parseReleaseImportSmokeRequest,
  releaseImportSmokeProfileIfRequested,
} from '../../src/main/release-smoke.js';

function smokeApp(profile = join(tmpdir(), 'overlook-release-import-smoke-test')) {
  mkdirSync(profile, { recursive: true });
  const exits: number[] = [];
  return {
    app: { isPackaged: true, getPath: () => profile, exit: (code: number) => exits.push(code) },
    exits,
    profile,
  };
}

describe('packaged release launch smoke (#357)', () => {
  test('does not intercept normal launches', async () => {
    const { app, exits } = smokeApp();
    assert.equal(await exitForReleaseSmokeIfRequested(app, ['Overlook']), false);
    assert.deepEqual(exits, []);
  });

  test('emits a stable readiness boundary for the verifier', async () => {
    let marker = '';
    const { app, exits } = smokeApp();
    assert.equal(
      await exitForReleaseSmokeIfRequested(app, ['Overlook', RELEASE_SMOKE_ARGUMENT], (value) => {
        marker = value;
      }),
      true,
    );
    assert.equal(marker, `${RELEASE_SMOKE_READY_MARKER}\n`);
    assert.deepEqual(exits, [0]);
  });

  test('the production writer flushes the marker synchronously before exit', () => {
    const source = readFileSync(join(process.cwd(), 'src/main/release-smoke.ts'), 'utf8');
    assert.match(source, /writeSync\(process\.stdout\.fd/u);
  });

  test('runs an import only with an absolute isolated profile matching Electron userData', async () => {
    const { app, exits, profile } = smokeApp();
    const source = join(tmpdir(), 'overlook-release-import-fixture.jpg');
    let request: { readonly sourcePath: string; readonly profilePath: string } | undefined;
    let output = '';
    const handled = await exitForReleaseSmokeIfRequested(
      app,
      [
        'Overlook',
        RELEASE_IMPORT_SMOKE_ARGUMENT,
        `--overlook-release-import-source=${source}`,
        `--overlook-release-import-profile=${profile}`,
      ],
      (value) => (output += value),
      (value) => {
        request = value;
        return Promise.resolve();
      },
    );
    assert.equal(handled, true);
    assert.deepEqual(request, { sourcePath: source, profilePath: await realpath(profile) });
    assert.equal(output, `${RELEASE_IMPORT_SMOKE_READY_MARKER}\n`);
    assert.deepEqual(exits, [0]);
  });

  test('selects the isolated profile before packaged app-profile configuration', () => {
    const { profile } = smokeApp();
    const resultPath = join(profile, 'release-import-result.txt');

    assert.equal(
      releaseImportSmokeProfileIfRequested({ isPackaged: true }, [
        'Overlook',
        RELEASE_IMPORT_SMOKE_ARGUMENT,
        `--overlook-release-import-profile=${profile}`,
        `--overlook-release-import-result=${resultPath}`,
      ]),
      profile,
    );
    assert.match(readFileSync(resultPath, 'utf8'), /overlook-release-import-smoke:progress:profile-bound/u);
    assert.equal(
      releaseImportSmokeProfileIfRequested({ isPackaged: false }, [
        'Overlook',
        RELEASE_IMPORT_SMOKE_ARGUMENT,
        `--overlook-release-import-profile=${profile}`,
        `--overlook-release-import-result=${resultPath}`,
      ]),
      undefined,
    );
  });

  test('requires the result marker path itself to be absolute', () => {
    const { profile } = smokeApp();

    assert.throws(
      () =>
        releaseImportSmokeProfileIfRequested({ isPackaged: true }, [
          'Overlook',
          RELEASE_IMPORT_SMOKE_ARGUMENT,
          `--overlook-release-import-profile=${profile}`,
          '--overlook-release-import-result=release-import-result.txt',
        ]),
      /release import result must be the dedicated marker file/u,
    );
  });

  test('rejects a result marker in another isolated profile on every filesystem', (t) => {
    const profile = mkdtempSync(join(tmpdir(), 'overlook-release-import-smoke-profile-'));
    t.after(() => rmSync(profile, { recursive: true, force: true }));
    const otherProfile = mkdtempSync(join(tmpdir(), 'overlook-release-import-smoke-other-'));
    t.after(() => rmSync(otherProfile, { recursive: true, force: true }));

    assert.throws(
      () =>
        releaseImportSmokeProfileIfRequested({ isPackaged: true }, [
          'Overlook',
          RELEASE_IMPORT_SMOKE_ARGUMENT,
          `--overlook-release-import-profile=${profile}`,
          `--overlook-release-import-result=${join(otherProfile, 'release-import-result.txt')}`,
        ]),
      /release import result must be the dedicated marker file/u,
    );
  });

  test('does not conflate case-distinct directories when the filesystem supports them', (t) => {
    const profile = mkdtempSync(join(tmpdir(), 'overlook-release-import-smoke-Case-'));
    t.after(() => rmSync(profile, { recursive: true, force: true }));
    const otherProfile = profile.replace('smoke-Case-', 'smoke-case-');
    try {
      mkdirSync(otherProfile);
    } catch (error) {
      // An existing alias is the only unsupported case; other I/O errors must fail.
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
      assert.equal(realpathSync.native(otherProfile), realpathSync.native(profile));
      t.skip('The temporary filesystem aliases case-distinct directory names');
      return;
    }
    t.after(() => rmSync(otherProfile, { recursive: true, force: true }));

    assert.throws(
      () =>
        releaseImportSmokeProfileIfRequested({ isPackaged: true }, [
          'Overlook',
          RELEASE_IMPORT_SMOKE_ARGUMENT,
          `--overlook-release-import-profile=${profile}`,
          `--overlook-release-import-result=${join(otherProfile, 'release-import-result.txt')}`,
        ]),
      /release import result must be the dedicated marker file/u,
    );
  });

  test('requires an on-disk app.asar for the explicit installed-artifact harness', async (t) => {
    const profile = mkdtempSync(join(tmpdir(), 'overlook-release-import-smoke-'));
    t.after(() => rmSync(profile, { recursive: true, force: true }));
    const archive = join(profile, 'app.asar');
    const source = join(tmpdir(), 'overlook-release-import-fixture.jpg');
    const result = join(profile, 'release-import-result.txt');
    // The harness checks for a physical file. Electron 45 intercepts writes
    // to the .asar path, so use the underlying filesystem to create it.
    const previousNoAsar = process.noAsar;
    process.noAsar = true;
    try {
      writeFileSync(archive, 'packaged bytes');
    } finally {
      process.noAsar = previousNoAsar;
    }
    const app = { isPackaged: false, getAppPath: () => archive, getPath: () => profile, exit: () => undefined };
    const argv = [
      'electron',
      RELEASE_IMPORT_SMOKE_ARGUMENT,
      `--overlook-release-import-source=${source}`,
      `--overlook-release-import-profile=${profile}`,
      `--overlook-release-import-result=${result}`,
    ];
    const environment = { OVERLOOK_RELEASE_IMPORT_SMOKE_HARNESS: '1' };

    await assert.rejects(parseReleaseImportSmokeRequest(app, argv), /packaged application archive/u);
    assert.equal(releaseImportSmokeProfileIfRequested(app, argv, environment), profile);
    assert.deepEqual(await parseReleaseImportSmokeRequest(app, argv, environment), {
      sourcePath: source,
      profilePath: await realpath(profile),
    });
    await assert.rejects(
      parseReleaseImportSmokeRequest({ ...app, getAppPath: () => join(profile, 'not-an-archive') }, argv, {
        OVERLOOK_RELEASE_IMPORT_SMOKE_HARNESS: '1',
      }),
      /packaged application archive/u,
    );
  });

  test('classifies the packaged import as headless before desktop startup', () => {
    const runtime = readFileSync(join(process.cwd(), 'src/main/interop/production-app-runtime.ts'), 'utf8');
    const entrypoint = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8');

    assert.match(runtime, /headlessRequested:\s*[\s\S]*?RELEASE_IMPORT_SMOKE_ARGUMENT/u);
    assert.match(entrypoint, /productionInterop\.headlessRequested\s*\?\s*createHeadlessExternalOpenRuntime\(\)/u);
    assert.match(entrypoint, /if \(!productionInterop\.headlessRequested\) \{\s*registerSingleInstance\(\)/u);
  });

  test('accepts one fixed launch flag with validated inherited smoke paths', async () => {
    const { app, profile } = smokeApp(join(tmpdir(), `overlook-release-import-smoke-${Date.now()}`));
    const source = join(tmpdir(), 'overlook-release-import-fixture.jpg');
    const result = join(profile, 'release-import-result.txt');
    const environment = {
      OVERLOOK_RELEASE_IMPORT_SMOKE_SOURCE: source,
      OVERLOOK_RELEASE_IMPORT_SMOKE_PROFILE: profile,
      OVERLOOK_RELEASE_IMPORT_SMOKE_RESULT: result,
    };

    assert.equal(releaseImportSmokeProfileIfRequested(app, ['Overlook', RELEASE_IMPORT_SMOKE_ARGUMENT], environment), profile);
    assert.deepEqual(await parseReleaseImportSmokeRequest(app, ['Overlook', RELEASE_IMPORT_SMOKE_ARGUMENT], environment), {
      sourcePath: source,
      profilePath: await realpath(profile),
    });
  });

  test('fails closed when the import profile is not the active isolated profile', async () => {
    const { app, exits } = smokeApp();
    let output = '';
    await exitForReleaseSmokeIfRequested(
      app,
      [
        'Overlook',
        RELEASE_IMPORT_SMOKE_ARGUMENT,
        `--overlook-release-import-source=${join(tmpdir(), 'fixture.jpg')}`,
        `--overlook-release-import-profile=${join(tmpdir(), 'overlook-release-import-smoke-other')}`,
      ],
      (value) => (output += value),
    );
    assert.match(output, new RegExp(`^${RELEASE_IMPORT_SMOKE_ERROR_MARKER}:`, 'u'));
    assert.deepEqual(exits, [1]);
  });
});
