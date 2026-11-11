import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';

interface SyncResult {
  readonly updated: boolean;
  readonly version: string;
  readonly previousLockVersion: string;
  readonly previousLockRootVersion: string;
}

interface SyncModule {
  readonly syncPackageLockVersion: (options?: { readonly rootDir?: string }) => SyncResult;
}

interface ChangedEntry {
  readonly status: string;
  readonly path: string;
}

interface PackageDoc {
  readonly name: string;
  readonly version: string;
  readonly private?: boolean;
  readonly dependencies?: Readonly<Record<string, string>>;
}

interface LockRootPackage {
  readonly name: string;
  readonly version: string;
  readonly dependencies?: Readonly<Record<string, string>>;
}

interface LockPackageEntry {
  readonly version: string;
  readonly integrity?: string;
}

interface LockDoc {
  readonly name: string;
  readonly version: string;
  readonly lockfileVersion: number;
  readonly packages: {
    readonly '': LockRootPackage;
    readonly [key: string]: LockRootPackage | LockPackageEntry;
  };
}

interface ValidateDocumentsInput {
  readonly basePackage: PackageDoc;
  readonly nextPackage: PackageDoc;
  readonly baseLock: LockDoc;
  readonly nextLock: LockDoc;
  readonly baseChangelog: string;
  readonly nextChangelog: string;
}

interface ValidateModule {
  readonly validateChangedEntries: (entries: readonly ChangedEntry[], pendingChangesets: readonly string[]) => string[];
  readonly validateVersionDocuments: (input: ValidateDocumentsInput) => string[];
  readonly validateStagedVersionCut: (options?: { readonly rootDir?: string }) => string;
}

const { syncPackageLockVersion } = (await import(
  pathToFileURL(join(process.cwd(), 'scripts/sync-package-lock-version.mjs')).href
)) as SyncModule;

const { validateChangedEntries, validateVersionDocuments, validateStagedVersionCut } = (await import(
  pathToFileURL(join(process.cwd(), 'scripts/validate-version-cut.mjs')).href
)) as ValidateModule;

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'overlook-version-cut-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function makeLock(version: string, rootVersion = version, name = 'overlook'): LockDoc {
  return {
    name,
    version,
    lockfileVersion: 3,
    packages: {
      '': {
        name,
        version: rootVersion,
        dependencies: {
          sharp: '0.35.5',
        },
      },
      'node_modules/sharp': {
        version: '0.35.5',
        integrity: 'sha512-fixed-integrity',
      },
    },
  };
}

describe('syncPackageLockVersion (#1267)', () => {
  test('updates only root lockfile versions and preserves dependencies and formatting', () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'overlook', version: '0.77.0' }, null, 2)}\n`, 'utf8');
      writeFileSync(join(dir, 'package-lock.json'), `${JSON.stringify(makeLock('0.76.42', '0.76.41'), null, 2)}\n`, 'utf8');

      const result = syncPackageLockVersion({ rootDir: dir });
      assert.deepEqual(result, {
        updated: true,
        version: '0.77.0',
        previousLockVersion: '0.76.42',
        previousLockRootVersion: '0.76.41',
      });

      const updatedText = readFileSync(join(dir, 'package-lock.json'), 'utf8');
      assert.equal(updatedText, `${JSON.stringify(makeLock('0.77.0'), null, 2)}\n`);

      const second = syncPackageLockVersion({ rootDir: dir });
      assert.equal(second.updated, false);
    });
  });

  test('rejects non-stable semver or mismatched lockfile root package names', () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'overlook', version: '0.77.0-rc.1' }, null, 2)}\n`, 'utf8');
      writeFileSync(join(dir, 'package-lock.json'), `${JSON.stringify(makeLock('0.76.42'), null, 2)}\n`, 'utf8');
      assert.throws(() => syncPackageLockVersion({ rootDir: dir }), /non-stable semver/u);

      writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'overlook', version: '0.77.0' }, null, 2)}\n`, 'utf8');
      writeFileSync(join(dir, 'package-lock.json'), `${JSON.stringify(makeLock('0.76.42', '0.76.42', 'other-pkg'), null, 2)}\n`, 'utf8');
      assert.throws(() => syncPackageLockVersion({ rootDir: dir }), /root package does not match/u);
    });
  });

  test('package.json changeset:version invokes sync-package-lock-version.mjs after changeset version', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      readonly scripts?: Readonly<Record<string, string>>;
    };
    assert.equal(pkg.scripts?.['changeset:version'], 'changeset version && node scripts/sync-package-lock-version.mjs');
  });
});

describe('validate-version-cut', () => {
  const basePackage: PackageDoc = { name: 'overlook', version: '0.76.42', private: true };
  const nextPackage: PackageDoc = { name: 'overlook', version: '0.77.0', private: true };
  const baseLock = makeLock('0.76.42');
  const nextLock = makeLock('0.77.0');
  const baseChangelog = '# photos\n\n## 0.76.42\n\n### Patch Changes\n\n- Prior fix.\n';
  const nextChangelog = '# photos\n\n## 0.77.0\n\n### Minor Changes\n\n- New feature.\n\n## 0.76.42\n\n### Patch Changes\n\n- Prior fix.\n';

  test('accepts a clean version-cut file set and document transition', () => {
    assert.deepEqual(
      validateChangedEntries(
        [
          { status: 'M', path: 'CHANGELOG.md' },
          { status: 'M', path: 'package-lock.json' },
          { status: 'M', path: 'package.json' },
          { status: 'D', path: '.changeset/feature-one.md' },
          { status: 'D', path: '.changeset/empty_governance.md' },
        ],
        ['.changeset/feature-one.md', '.changeset/empty_governance.md'],
      ),
      [],
    );

    assert.deepEqual(
      validateVersionDocuments({
        basePackage,
        nextPackage,
        baseLock,
        nextLock,
        baseChangelog,
        nextChangelog,
      }),
      [],
    );
  });

  test('rejects forbidden paths, unconsumed changesets, lockfile drift, and malformed changelogs', () => {
    const entryErrors = validateChangedEntries(
      [
        { status: 'M', path: 'CHANGELOG.md' },
        { status: 'M', path: 'package.json' },
        { status: 'M', path: 'scripts/publish-signed-version-commit.mjs' },
      ],
      ['.changeset/feature-one.md'],
    );
    assert.ok(entryErrors.some((err) => err.includes('forbidden path "scripts/publish-signed-version-commit.mjs"')));
    assert.ok(entryErrors.some((err) => err.includes('version patch must modify package-lock.json')));
    assert.ok(entryErrors.some((err) => err.includes('version patch must consume pending changeset .changeset/feature-one.md')));

    const driftedLock: LockDoc = {
      ...nextLock,
      packages: {
        ...nextLock.packages,
        'node_modules/sharp': { version: '0.35.6', integrity: 'sha512-tampered' },
      },
    };
    const docErrors = validateVersionDocuments({
      basePackage,
      nextPackage: { ...nextPackage, dependencies: { injected: '1.0.0' } },
      baseLock,
      nextLock: driftedLock,
      baseChangelog,
      nextChangelog: '# photos\n\n## 0.77.0\n\n## 0.76.42\n\n### Patch Changes\n\n- Tampered.\n',
    });
    assert.ok(docErrors.some((err) => err.includes('package.json changes fields other than version')));
    assert.ok(docErrors.some((err) => err.includes('package-lock.json changes fields other than synchronized root versions')));
    assert.ok(docErrors.some((err) => err.includes('CHANGELOG.md must prepend')));
  });

  test('validates a real staged Git index and rejects tampered staged paths', () => {
    withTempDir((dir) => {
      const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
      git('init');
      git('config', 'user.name', 'Test Runner');
      git('config', 'user.email', 'test@example.com');
      git('config', 'commit.gpgsign', 'false');

      mkdirSync(join(dir, '.changeset'), { recursive: true });
      writeFileSync(join(dir, '.changeset', 'README.md'), '# Changesets\n', 'utf8');
      writeFileSync(join(dir, '.changeset', 'add-feature.md'), '---\n"overlook": minor\n---\n\nNew feature.\n', 'utf8');
      writeFileSync(join(dir, '.changeset', 'chore-empty.md'), '---\n---\n', 'utf8');
      writeFileSync(join(dir, 'package.json'), `${JSON.stringify(basePackage, null, 2)}\n`, 'utf8');
      writeFileSync(join(dir, 'package-lock.json'), `${JSON.stringify(baseLock, null, 2)}\n`, 'utf8');
      writeFileSync(join(dir, 'CHANGELOG.md'), baseChangelog, 'utf8');

      git('add', '-A');
      git('commit', '-m', 'base');

      writeFileSync(join(dir, 'package.json'), `${JSON.stringify(nextPackage, null, 2)}\n`, 'utf8');
      syncPackageLockVersion({ rootDir: dir });
      writeFileSync(join(dir, 'CHANGELOG.md'), nextChangelog, 'utf8');
      rmSync(join(dir, '.changeset', 'add-feature.md'));
      rmSync(join(dir, '.changeset', 'chore-empty.md'));
      git('add', '-A');

      assert.equal(validateStagedVersionCut({ rootDir: dir }), '0.77.0');

      writeFileSync(join(dir, 'evil.mjs'), 'console.log("oops");\n', 'utf8');
      git('add', 'evil.mjs');
      assert.throws(() => validateStagedVersionCut({ rootDir: dir }), /forbidden path "evil\.mjs"/u);
    });
  });
});
