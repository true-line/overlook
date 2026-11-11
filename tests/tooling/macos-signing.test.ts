import assert from 'node:assert/strict';
import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  OVERLOOK_ICLOUD_CONTAINER_ID,
  OVERLOOK_MAC_APPLICATION_ID,
  OVERLOOK_MAC_BUNDLE_ID,
  OVERLOOK_PRODUCT_NAME,
  OVERLOOK_TEAM_ID,
} from '../../src/shared/app-identity.js';
import type {
  ExpectedProvisioningIdentity,
  ProvisioningCommandRunner,
  ProvisioningProfileMetadata,
} from '../../scripts/provisioning-profile.mjs';

const root = process.cwd();

interface ProvisioningProfileModule {
  readonly readProvisioningProfile: (profilePath: string, run?: ProvisioningCommandRunner) => ProvisioningProfileMetadata;
  readonly validateProvisioningProfile: (
    metadata: ProvisioningProfileMetadata,
    expected: ExpectedProvisioningIdentity,
    now?: number,
  ) => void;
}

interface MacSignModule {
  readonly abstractStringEntitlement: (source: string, key: string) => string | null;
  readonly isTransientTimestampError: (error: unknown) => boolean;
  readonly withTimestampRetry: <T>(
    operation: () => Promise<T> | T,
    options?: {
      readonly attempts?: number;
      readonly baseDelayMs?: number;
      readonly sleep?: (ms: number) => Promise<void>;
    },
  ) => Promise<T>;
  readonly signNestedBundle: (
    configuration: { readonly identity?: string },
    bundlePath: string,
    entitlements: string,
    run?: (cmd: string, args: readonly string[], options: ExecFileSyncOptionsWithStringEncoding) => string,
    options?: {
      readonly attempts?: number;
      readonly baseDelayMs?: number;
      readonly sleepSync?: (ms: number) => void;
    },
  ) => void;
  readonly nestedCodeSignArguments: (
    configuration: {
      readonly identity?: string;
      readonly keychain?: string;
      readonly optionsForFile?: (filePath: string) => {
        readonly additionalArguments?: string[];
        readonly hardenedRuntime?: boolean;
        readonly requirements?: string;
        readonly signatureFlags?: string | string[];
        readonly timestamp?: string;
      };
    },
    bundlePath: string,
    entitlements: string,
  ) => string[];
}

function provisioningProfileModule(): Promise<ProvisioningProfileModule> {
  return import(pathToFileURL(join(root, 'scripts/provisioning-profile.mjs')).href) as Promise<ProvisioningProfileModule>;
}

function macSignModule(): Promise<MacSignModule> {
  return import(pathToFileURL(join(root, 'scripts/sign-macos-app.mjs')).href) as Promise<MacSignModule>;
}

function source(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

describe('macOS release signing safety (#357)', () => {
  test('canonical identity keeps the existing product and user-data name (#374)', () => {
    const builder = source('electron-builder.yml');
    const main = source('src/main/index.ts');
    assert.equal(OVERLOOK_MAC_BUNDLE_ID, 'com.zts1.overlook');
    assert.equal(OVERLOOK_MAC_APPLICATION_ID, 'Z5DM34QS5U.com.zts1.overlook');
    assert.equal(OVERLOOK_TEAM_ID, 'Z5DM34QS5U');
    assert.equal(OVERLOOK_PRODUCT_NAME, 'Overlook');
    assert.match(builder, /^appId: com\.zts1\.overlook$/mu);
    assert.match(builder, /^productName: Overlook$/mu);
    assert.ok(main.indexOf('app.setName(OVERLOOK_PRODUCT_NAME)') < main.indexOf("app.getPath('userData')"));
  });

  test('the default Developer ID build claims no profile-restricted identity entitlements', () => {
    const entitlements = source('build/entitlements.mac.plist');
    assert.doesNotMatch(entitlements, /com\.apple\.application-identifier/u);
    assert.doesNotMatch(entitlements, /com\.apple\.developer\.team-identifier/u);
  });

  test('restricted Touch ID and iCloud identities are isolated behind the provisioned package command', () => {
    const packageJson = JSON.parse(source('package.json')) as { readonly scripts?: Record<string, string> };
    const builder = source('electron-builder.yml');
    const provisioned = source('build/entitlements.mac.provisioned.plist');
    const packager = source('scripts/package-signed-provisioned.mjs');
    for (const identity of ['Z5DM34QS5U', 'Z5DM34QS5U.com.zts1.overlook']) {
      assert.match(provisioned, new RegExp(identity, 'u'));
    }
    for (const entitlement of [
      'com.apple.developer.icloud-services',
      'com.apple.developer.icloud-container-identifiers',
      'com.apple.developer.ubiquity-container-identifiers',
      OVERLOOK_ICLOUD_CONTAINER_ID,
      'CloudDocuments',
    ]) {
      assert.match(provisioned, new RegExp(entitlement.replaceAll('.', '\\.'), 'u'));
    }
    assert.match(packager, /iCloud\.com\.zts1\.overlook/u);
    assert.match(packager, /Z5DM34QS5U/u);
    assert.match(packager, /com\.zts1\.overlook/u);
    assert.match(packageJson.scripts?.['dist:signed:provisioned'] ?? '', /package-signed-provisioned\.mjs/u);
    assert.match(packager, /OVERLOOK_MAC_PROVISIONING_PROFILE/u);
    assert.match(packager, /OVERLOOK_FILE_PROVIDER_PROVISIONING_PROFILE/u);
    assert.match(packager, /com\.zts1\.overlook\.file-provider/u);
    assert.match(packager, /appGroupId/u);
    assert.match(packager, /provisioningProfile/u);
    assert.match(packager, /--validate-only/u);
    assert.match(builder, /NSFaceIDUsageDescription/u);
    assert.match(builder, /Unlock Overlook with Touch ID/u);
  });

  test('the package workflow validates that the packaged app can start with provisioned identity', () => {
    const workflow = source('.github/workflows/package.yml');
    const provisioningProfile = source('scripts/provisioning-profile.mjs');
    const provisionedVerifier = source('scripts/verify-macos-provisioned-app.mjs');
    const launchVerifier = source('scripts/verify-macos-app-launch.mjs');
    assert.match(workflow, /verify-macos-provisioned-app\.mjs/u);
    assert.match(workflow, /verify-macos-app-launch\.mjs/u);
    assert.match(workflow, /OVERLOOK_IMAGE_TRAIL_EXTENSION_ID: \$\{\{ vars\.IMAGE_TRAIL_EXTENSION_ID \}\}/u);
    assert.match(workflow, /FILE_PROVIDER_PROVISIONING_PROFILE/u);
    assert.match(workflow, /\*-mac\.zip/u);
    for (const contract of [
      'embedded.provisionprofile',
      'NSFaceIDUsageDescription',
      'com.apple.application-identifier',
      'com.apple.developer.team-identifier',
      'com.apple.developer.icloud-services',
      'com.apple.developer.icloud-container-identifiers',
      'com.apple.developer.ubiquity-container-identifiers',
      'Overlook Helper (Renderer)',
      'OverlookFileProvider.appex',
      'com.apple.security.application-groups',
      'com.apple.security.app-sandbox',
      'com.apple.security.network.client',
    ]) {
      assert.ok(provisionedVerifier.includes(contract), `verifier must enforce ${contract}`);
    }
    assert.match(provisionedVerifier, /ICLOUD_CONTAINER_ID = `iCloud\.\$\{BUNDLE_ID\}`/u);
    assert.match(provisionedVerifier, /UBIQUITY_CONTAINER_ID = ICLOUD_CONTAINER_ID/u);
    assert.match(provisionedVerifier, /codesign/u);
    for (const binary of ['ditto', 'plutil']) assert.match(launchVerifier, new RegExp(binary, 'u'));
    for (const binary of ['plutil', 'security']) assert.match(provisioningProfile, new RegExp(binary, 'u'));
  });

  test('builds and signs the nested File Provider extension with its own identity', async () => {
    const builder = source('electron-builder.yml');
    const buildExtension = source('scripts/build-file-provider-extension.mjs');
    const signer = source('scripts/sign-macos-app.mjs');
    const extensionInfo = source('native/file-provider-extension/Info.plist');
    const extensionEntitlements = source('native/file-provider-extension/entitlements.plist');
    assert.match(builder, /sign: scripts\/sign-macos-app\.mjs/u);
    assert.match(buildExtension, /OVERLOOK_FILE_PROVIDER_PROVISIONING_PROFILE/u);
    assert.match(buildExtension, /OVERLOOK_MAC_PROVISIONING_PROFILE/u);
    assert.match(buildExtension, /embedded\.provisionprofile/u);
    assert.match(buildExtension, /ElectronTeamID/u);
    assert.match(buildExtension, /xcrun/u);
    assert.doesNotMatch(buildExtension, /'-bundle'/u);
    assert.match(buildExtension, /'-fapplication-extension'/u);
    assert.match(buildExtension, /'-Wl,-e,_NSExtensionMain'/u);
    assert.match(buildExtension, /otool/u);
    assert.match(buildExtension, /\\bEXECUTE\\b/u);
    assert.match(signer, /signNestedBundle/u);
    assert.match(signer, /nestedCodeSignArguments/u);
    assert.match(signer, /verifyFileProviderIdentity/u);
    assert.match(signer, /requiredEntitlements\(configuration, configuration\.app\)/u);
    assert.match(signer, /--verify', '--deep', '--strict'/u);
    assert.match(signer, /Contents.*PlugIns.*OverlookFileProvider\.appex/u);
    assert.match(signer, /preEmbedProvisioningProfile: false/u);
    assert.match(signer, /preAutoEntitlements: false/u);
    assert.match(signer, /OverlookFileProvider\.appex/u);
    assert.match(signer, /file-provider-extension\/entitlements\.plist/u);
    assert.match(extensionInfo, /com\.apple\.fileprovider-nonui/u);
    for (const contract of [
      'Z5DM34QS5U.com.zts1.overlook.file-provider',
      'com.apple.security.app-sandbox',
      'com.apple.security.application-groups',
      'com.apple.security.network.client',
    ]) {
      assert.match(extensionEntitlements, new RegExp(contract.replaceAll('.', '\\.')));
    }

    const { abstractStringEntitlement, nestedCodeSignArguments } = await macSignModule();
    assert.deepEqual(
      nestedCodeSignArguments(
        {
          identity: 'Developer ID hash',
          keychain: '/tmp/agent.keychain',
          optionsForFile: () => ({
            additionalArguments: ['--generate-entitlement-der'],
            hardenedRuntime: true,
            requirements: '=designated => anchor apple generic',
            signatureFlags: ['library'],
            timestamp: 'none',
          }),
        },
        '/tmp/OverlookFileProvider.appex',
        '/tmp/file-provider-entitlements.plist',
      ),
      [
        '--sign',
        'Developer ID hash',
        '--force',
        '--keychain',
        '/tmp/agent.keychain',
        '--timestamp=none',
        '--options',
        'library,runtime',
        '-r=designated => anchor apple generic',
        '--generate-entitlement-der',
        '--entitlements',
        '/tmp/file-provider-entitlements.plist',
        '/tmp/OverlookFileProvider.appex',
      ],
    );
    const misleadingEntitlements = `[Dict]
\t[Key] com.apple.application-identifier
\t[Value]
\t\t[String] Z5DM34QS5U.com.zts1.overlook
\t[Key] com.apple.security.application-groups
\t[Value]
\t\t[Array]
\t\t\t[String] Z5DM34QS5U.com.zts1.overlook.file-provider`;
    assert.equal(abstractStringEntitlement(misleadingEntitlements, 'com.apple.application-identifier'), 'Z5DM34QS5U.com.zts1.overlook');
  });

  test('builds a sandboxed privacy-safe Quick Look extension without custody entitlements (#799)', () => {
    const builder = source('electron-builder.yml');
    const buildExtension = source('scripts/build-quick-look-extension.mjs');
    const afterPack = source('scripts/prune-foreign-binaries.mjs');
    const signer = source('scripts/sign-macos-app.mjs');
    const verifier = source('scripts/verify-macos-provisioned-app.mjs');
    const extension = source('native/quick-look-extension/OverlookQuickLook.m');
    const info = source('native/quick-look-extension/Info.plist');
    const entitlements = source('native/quick-look-extension/entitlements.plist');
    for (const contract of ['com.zts1.overlook.library', 'com.apple.package', 'overlooklibrary'])
      assert.match(builder, new RegExp(contract));
    assert.match(buildExtension, /QuickLookUI/u);
    assert.doesNotMatch(buildExtension, /'-bundle'/u);
    assert.match(buildExtension, /'-fapplication-extension'/u);
    assert.match(buildExtension, /'-Wl,-e,_NSExtensionMain'/u);
    assert.match(buildExtension, /\\bEXECUTE\\b/u);
    assert.match(afterPack, /buildQuickLookExtension/u);
    assert.match(signer, /OverlookQuickLook\.appex/u);
    assert.match(signer, /quick-look-extension\/entitlements\.plist/u);
    assert.match(verifier, /OverlookQuickLook\.appex/u);
    assert.match(verifier, /trueEntitlement\(quickLookEntitlements, 'com\.apple\.security\.app-sandbox'\)/u);
    assert.match(verifier, /Quick Look extension unexpectedly claims/u);
    assert.match(info, /com\.apple\.quicklook\.preview/u);
    assert.match(info, /com\.zts1\.overlook\.library/u);
    assert.match(entitlements, /com\.apple\.security\.app-sandbox/u);
    for (const forbidden of ['library.db', 'library-id', 'master.key', 'keys.json', 'thumbnail', 'album']) {
      assert.doesNotMatch(extension, new RegExp(forbidden.replace('.', '\\.'), 'iu'));
    }
    assert.match(extension, /OverlookSummary\.json/u);
    assert.match(extension, /SummaryLimit = 4096/u);
  });

  test('the signed app executable is the native messaging host and registration is build-identity gated', () => {
    const config = source('src/main/build-config.ts');
    const vite = source('electron.vite.config.ts');
    const appRuntime = source('src/main/interop/production-app-runtime.ts');
    const host = source('src/main/interop/icloud-native-host.ts');
    const registration = source('src/main/interop/icloud-native-registration.ts');
    assert.match(config, /__OVERLOOK_IMAGE_TRAIL_EXTENSION_ID__/u);
    assert.ok(config.includes('const CHROMIUM_EXTENSION_ID = /^[a-p]{32}$/u;'));
    assert.match(vite, /OVERLOOK_IMAGE_TRAIL_EXTENSION_ID/u);
    assert.match(appRuntime, /executablePath: app\.getPath\('exe'\)/u);
    assert.match(host, /allowed_origins/u);
    assert.match(registration, /NativeMessagingHosts/u);
    assert.doesNotMatch(registration, /\\.sh['"`]/u);
  });
});

describe('provisioning profile validation (#360)', () => {
  test('extracts only JSON-safe fields from the decoded CMS payload', async () => {
    const { readProvisioningProfile, validateProvisioningProfile } = await provisioningProfileModule();
    const plist = Buffer.from('<plist><dict><key>DeveloperCertificates</key><array><data>binary</data></array></dict></plist>');
    const calls: Array<{ readonly file: string; readonly args: readonly string[] }> = [];
    const run: ProvisioningCommandRunner = (file, args) => {
      calls.push({ file, args });
      if (file === 'security') return plist;
      const key = args[1];
      if (key === 'Entitlements') {
        return JSON.stringify({
          'com.apple.application-identifier': OVERLOOK_MAC_APPLICATION_ID,
          'com.apple.developer.team-identifier': OVERLOOK_TEAM_ID,
        });
      }
      if (key === 'TeamIdentifier') return JSON.stringify([OVERLOOK_TEAM_ID]);
      if (key === 'ExpirationDate') return '2044-07-12T01:24:19Z';
      throw new Error(`unexpected extraction key ${String(key)}`);
    };

    const metadata = readProvisioningProfile('/tmp/overlook.provisionprofile', run);
    validateProvisioningProfile(metadata, { applicationId: OVERLOOK_MAC_APPLICATION_ID, teamId: OVERLOOK_TEAM_ID }, 0);
    assert.deepEqual(
      calls.map(({ file, args }) => [file, ...args.slice(0, 4)]),
      [
        ['security', 'cms', '-D', '-i', '/tmp/overlook.provisionprofile'],
        ['plutil', '-extract', 'Entitlements', 'json', '-o'],
        ['plutil', '-extract', 'TeamIdentifier', 'json', '-o'],
        ['plutil', '-extract', 'ExpirationDate', 'raw', '-o'],
      ],
    );
    assert.ok(calls.filter(({ file }) => file === 'plutil').every(({ args }) => args[0] === '-extract'));
  });

  test('fails closed for wrong identity and expiry', async () => {
    const { validateProvisioningProfile } = await provisioningProfileModule();
    const valid = {
      entitlements: {
        'com.apple.application-identifier': OVERLOOK_MAC_APPLICATION_ID,
        'com.apple.developer.team-identifier': OVERLOOK_TEAM_ID,
      },
      teams: [OVERLOOK_TEAM_ID],
      expiresAt: Date.parse('2044-07-12T01:24:19Z'),
    };
    const expected = { applicationId: OVERLOOK_MAC_APPLICATION_ID, teamId: OVERLOOK_TEAM_ID };
    assert.throws(
      () => validateProvisioningProfile({ ...valid, entitlements: {} }, expected, 0),
      /does not authorize application identifier/u,
    );
    assert.throws(() => validateProvisioningProfile({ ...valid, teams: [] }, expected, 0), /TeamIdentifier/u);
    assert.throws(
      () => validateProvisioningProfile({ ...valid, expiresAt: Date.parse('2020-01-01T00:00:00Z') }, expected, Date.now()),
      /expired/u,
    );
  });

  test('fails closed unless the profile authorizes the iCloud Documents container (#656)', async () => {
    const { validateProvisioningProfile } = await provisioningProfileModule();
    const entitlements = {
      'com.apple.application-identifier': OVERLOOK_MAC_APPLICATION_ID,
      'com.apple.developer.team-identifier': OVERLOOK_TEAM_ID,
      'com.apple.developer.icloud-container-identifiers': [OVERLOOK_ICLOUD_CONTAINER_ID],
      'com.apple.developer.ubiquity-container-identifiers': [OVERLOOK_ICLOUD_CONTAINER_ID],
      'com.apple.developer.icloud-services': '*',
    };
    const metadata = {
      entitlements,
      teams: [OVERLOOK_TEAM_ID],
      expiresAt: Date.parse('2044-07-12T01:24:19Z'),
    };
    const expected = {
      applicationId: OVERLOOK_MAC_APPLICATION_ID,
      teamId: OVERLOOK_TEAM_ID,
      iCloudContainerId: OVERLOOK_ICLOUD_CONTAINER_ID,
      ubiquityContainerId: OVERLOOK_ICLOUD_CONTAINER_ID,
    };
    validateProvisioningProfile(metadata, expected, 0);
    validateProvisioningProfile(
      metadata,
      {
        applicationId: OVERLOOK_MAC_APPLICATION_ID,
        teamId: OVERLOOK_TEAM_ID,
        iCloudContainerId: OVERLOOK_ICLOUD_CONTAINER_ID,
      },
      0,
    );
    assert.throws(
      () =>
        validateProvisioningProfile(
          {
            ...metadata,
            entitlements: { ...entitlements, 'com.apple.developer.icloud-container-identifiers': [] },
          },
          {
            applicationId: OVERLOOK_MAC_APPLICATION_ID,
            teamId: OVERLOOK_TEAM_ID,
            iCloudContainerId: OVERLOOK_ICLOUD_CONTAINER_ID,
          },
          0,
        ),
      /does not authorize iCloud container/u,
    );
    validateProvisioningProfile(
      {
        ...metadata,
        entitlements: {
          ...entitlements,
          'com.apple.developer.ubiquity-container-identifiers': ['iCloud.com.zts1.*'],
        },
      },
      expected,
      0,
    );
    validateProvisioningProfile(
      {
        ...metadata,
        entitlements: { ...entitlements, 'com.apple.developer.icloud-services': ['CloudDocuments'] },
      },
      expected,
      0,
    );
    for (const unauthorized of ['iCloud.com.zts1.other', 'iCloud.com.zts1*', 'iCloud.com.other.*']) {
      assert.throws(
        () =>
          validateProvisioningProfile(
            {
              ...metadata,
              entitlements: {
                ...entitlements,
                'com.apple.developer.ubiquity-container-identifiers': [unauthorized],
              },
            },
            expected,
            0,
          ),
        /does not authorize ubiquity container/u,
      );
    }
    for (const key of [
      'com.apple.developer.icloud-container-identifiers',
      'com.apple.developer.ubiquity-container-identifiers',
      'com.apple.developer.icloud-services',
    ]) {
      assert.throws(
        () => validateProvisioningProfile({ ...metadata, entitlements: { ...entitlements, [key]: [] } }, expected, 0),
        /does not authorize/u,
      );
    }
  });

  test('fails closed unless the profile authorizes the exact File Provider app group (#797)', async () => {
    const { validateProvisioningProfile } = await provisioningProfileModule();
    const appGroupId = `${OVERLOOK_TEAM_ID}.com.zts1.overlook.file-provider`;
    const metadata = {
      entitlements: {
        'com.apple.application-identifier': OVERLOOK_MAC_APPLICATION_ID,
        'com.apple.developer.team-identifier': OVERLOOK_TEAM_ID,
        'com.apple.security.application-groups': [appGroupId],
      },
      teams: [OVERLOOK_TEAM_ID],
      expiresAt: Date.parse('2044-07-12T01:24:19Z'),
    };
    const expected = { applicationId: OVERLOOK_MAC_APPLICATION_ID, teamId: OVERLOOK_TEAM_ID, appGroupId };
    validateProvisioningProfile(metadata, expected, 0);
    assert.throws(
      () =>
        validateProvisioningProfile(
          { ...metadata, entitlements: { ...metadata.entitlements, 'com.apple.security.application-groups': [] } },
          expected,
          0,
        ),
      /does not authorize app group/u,
    );
  });
});

describe('transient Apple timestamp authority resilience (#1463)', () => {
  test('batches identical-rank codesign calls and retries only transient TSA errors', async () => {
    const signer = source('scripts/sign-macos-app.mjs');
    assert.match(signer, /batchCodesignCalls:\s*configuration\.batchCodesignCalls\s*\?\?\s*true/u);
    assert.match(signer, /await withTimestampRetry\(\(\)\s*=>\s*sign\(/u);

    const { isTransientTimestampError, withTimestampRetry } = await macSignModule();
    assert.equal(isTransientTimestampError(new Error('kn.lproj/locale.pak: A timestamp was expected but was not found.')), true);
    assert.equal(isTransientTimestampError({ stderr: Buffer.from('The timestamp service is not available.\n') }), true);
    assert.equal(isTransientTimestampError('unable to communicate with the timestamp service'), true);
    assert.equal(isTransientTimestampError(new Error('errSecInternalComponent')), false);

    const delays: number[] = [];
    let asyncAttempts = 0;
    const result = await withTimestampRetry(
      () => {
        asyncAttempts += 1;
        if (asyncAttempts < 3) throw new Error('A timestamp was expected but was not found.');
        return 'signed';
      },
      { attempts: 4, baseDelayMs: 500, sleep: (ms) => (delays.push(ms), Promise.resolve()) },
    );
    assert.equal(result, 'signed');
    assert.equal(asyncAttempts, 3);
    assert.deepEqual(delays, [500, 1000]);

    await assert.rejects(
      () =>
        withTimestampRetry(
          () => {
            throw new Error('invalid entitlement');
          },
          { attempts: 4, baseDelayMs: 500, sleep: (ms) => (delays.push(ms), Promise.resolve()) },
        ),
      /invalid entitlement/u,
    );
    assert.deepEqual(delays, [500, 1000]);
  });

  test('signNestedBundle pipes codesign stderr so execFileSync TSA failures retry', async () => {
    const { signNestedBundle } = await macSignModule();
    const syncDelays: number[] = [];
    let syncAttempts = 0;
    signNestedBundle(
      { identity: 'Developer ID hash' },
      '/tmp/OverlookQuickLook.appex',
      '/tmp/quick-look-entitlements.plist',
      (_cmd, _args, options) => {
        assert.deepEqual(options, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        syncAttempts += 1;
        if (syncAttempts === 1) {
          return execFileSync(
            process.execPath,
            ['-e', 'process.stderr.write("A timestamp was expected but was not found.\\n"); process.exit(1);'],
            options,
          );
        }
        return '';
      },
      { attempts: 3, baseDelayMs: 250, sleepSync: (ms) => syncDelays.push(ms) },
    );
    assert.equal(syncAttempts, 2);
    assert.deepEqual(syncDelays, [250]);
  });
});
