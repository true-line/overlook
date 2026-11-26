import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const root = process.cwd();

interface ClosureRecord {
  readonly name: string;
  readonly version: string;
  readonly license: string;
  readonly licenseText: string | null;
  readonly conditional?: boolean;
}

interface NoticesModule {
  readonly assertLicenseTextsResolvable: (closure: readonly ClosureRecord[]) => void;
}

interface DependencyClosureModule {
  readonly resolveShippedClosure: () => readonly ClosureRecord[];
}

function noticesModule(): Promise<NoticesModule> {
  return import(pathToFileURL(join(root, 'scripts/generate-third-party-notices.mjs')).href) as Promise<NoticesModule>;
}

function dependencyClosureModule(): Promise<DependencyClosureModule> {
  return import(pathToFileURL(join(root, 'scripts/dependency-closure.mjs')).href) as Promise<DependencyClosureModule>;
}

function pkg(name: string, licenseText: string | null, conditional = false): ClosureRecord {
  return { name, version: '1.0.0', license: 'MIT', licenseText, conditional };
}

// The closure is resolved from the lockfile but license texts are read from installed
// packages, so a pruned or absent node_modules yields records with licenseText === null.
// renderNotices turns those into the same "_No license text file was found_" note used
// for packages that genuinely publish none, and --check certifies the result because it
// re-renders from the same input. These pin the guard that stops it.
describe('third-party notices license-text guard', () => {
  test('accepts a closure whose shipped packages all resolved their texts', async () => {
    const { assertLicenseTextsResolvable } = await noticesModule();
    assert.doesNotThrow(() => assertLicenseTextsResolvable([pkg('a', 'MIT text'), pkg('b', 'MIT text')]));
  });

  test('rejects a single unexpected missing text, naming the package', async () => {
    const { assertLicenseTextsResolvable } = await noticesModule();
    // The case a proportional threshold cannot catch: a production-only install drops
    // electron alone — a devDependency whose runtime ships — and one absent record out
    // of ~72 clears any sane floor while dropping the license of a distributed package.
    const closure = [pkg('a', 'MIT text'), pkg('b', 'MIT text'), pkg('electron', null)];
    assert.throws(() => assertLicenseTextsResolvable(closure), /electron/u);
  });

  test('rejects every unexpected missing text at once rather than one per run', async () => {
    const { assertLicenseTextsResolvable } = await noticesModule();
    const closure = [pkg('a', null), pkg('b', null)];
    assert.throws(
      () => assertLicenseTextsResolvable(closure),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        return message.includes('a') && message.includes('b');
      },
    );
  });

  test('packages known to publish no license file are exempt', async () => {
    const { assertLicenseTextsResolvable } = await noticesModule();
    const closure = [pkg('sqlite-vec', null), pkg('standardwebhooks', null), pkg('a', 'MIT text')];
    assert.doesNotThrow(() => assertLicenseTextsResolvable(closure));
  });

  test('optional platform variants are exempt — they install on only one host', async () => {
    const { assertLicenseTextsResolvable } = await noticesModule();
    const closure = [pkg('sharp-linux-x64', null, true), pkg('sharp-win32-x64', null, true)];
    assert.doesNotThrow(() => assertLicenseTextsResolvable(closure));
  });

  test('preserves both the primary and supplemental Anthropic SDK license texts', async () => {
    const { resolveShippedClosure } = await dependencyClosureModule();
    const sdk = resolveShippedClosure().find((pkg) => pkg.name === '@anthropic-ai/sdk');
    assert.ok(sdk?.licenseText);
    const sdkDir = join(root, 'node_modules/@anthropic-ai/sdk');
    for (const name of ['LICENSE', 'LICENSE-MIT']) {
      const text = readFileSync(join(sdkDir, name), 'utf8').replaceAll('\r\n', '\n').trim();
      assert.ok(sdk.licenseText.includes(text), `Anthropic SDK notices omit ${name}`);
    }
  });

  test('the real shipped closure passes, so the exemption list matches reality', async () => {
    const [{ assertLicenseTextsResolvable }, { resolveShippedClosure }] = await Promise.all([noticesModule(), dependencyClosureModule()]);
    // If a dependency change introduces a package that publishes no license file, this
    // fails here — naming it — rather than blocking an unrelated PR at the licences gate.
    assert.doesNotThrow(() => assertLicenseTextsResolvable(resolveShippedClosure()));
  });
});
