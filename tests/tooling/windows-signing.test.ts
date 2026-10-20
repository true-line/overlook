import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

const root = process.cwd();

function source(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

describe('Windows ARM64 packaging + signing (#683)', () => {
  test('the package matrix builds macOS plus a Windows leg per architecture', () => {
    const workflow = source('.github/workflows/package.yml');
    assert.match(workflow, /include:/u);
    assert.match(workflow, /os: macos-latest/u);
    assert.match(workflow, /os: windows-latest\s+win-arch: x64/u);
    assert.match(workflow, /os: windows-latest\s+win-arch: arm64/u);
    // No lingering single-axis matrix that would build only one Windows arch.
    assert.doesNotMatch(workflow, /os: \[macos-latest, windows-latest\]/u);
  });

  test('artifacts are architecture-qualified so the two Windows legs never collide', () => {
    const workflow = source('.github/workflows/package.yml');
    const builder = source('electron-builder.yml');
    assert.match(
      workflow,
      /name: overlook-\$\{\{ matrix\.win-arch != '' && format\('windows-\{0\}', matrix\.win-arch\) \|\| matrix\.os \}\}/u,
    );
    assert.match(builder, /artifactName: \$\{productName\}-\$\{version\}-\$\{arch\}\.\$\{ext\}/u);
  });

  test('each Windows leg drives the arch through a dedicated dist script', () => {
    const packageJson = JSON.parse(source('package.json')) as { readonly scripts?: Record<string, string> };
    const workflow = source('.github/workflows/package.yml');
    assert.match(packageJson.scripts?.['dist:win:x64'] ?? '', /electron-builder --publish never --win --x64/u);
    assert.match(packageJson.scripts?.['dist:win:arm64'] ?? '', /electron-builder --publish never --win --arm64/u);
    assert.match(workflow, /npm run "dist:win:\$WIN_ARCH"/u);
    assert.match(workflow, /WIN_ARCH: \$\{\{ matrix\.win-arch \}\}/u);
  });

  test('every Windows leg verifies the payload architecture post-build', () => {
    const workflow = source('.github/workflows/package.yml');
    assert.match(workflow, /node scripts\/verify-windows-arch\.mjs "\$WIN_ARCH"/u);
  });

  test('runs each installed artifact on a matching native Windows runner', () => {
    const workflow = source('.github/workflows/package.yml');
    const smoke = source('scripts/verify-windows-packaged-import.ps1');
    assert.match(workflow, /^ {2}installed-windows-import:/mu);
    assert.match(workflow, /arch: x64\s+runner: windows-latest/u);
    // The arm64 leg runs natively on the organisation's arm64 Windows runner.
    // A fork's pull request and a merge-queue run keep a hosted arm64 runner,
    // because a pull request controls the workflow file it runs.
    assert.match(
      workflow,
      /arch: arm64\s+runner: self-hosted-windows-arm64\s+labels: '\["self-hosted", "Windows", "ARM64"\]'\s+hosted: '\["windows-11-arm"\]'/u,
    );
    assert.match(workflow, /name: overlook-windows-\$\{\{ matrix\.arch \}\}/u);
    assert.match(workflow, /Get-ChildItem .* -File -Recurse/u);
    assert.match(workflow, /verify-windows-packaged-import\.ps1/u);
    assert.match(workflow, /-Architecture '\$\{\{ matrix\.arch \}\}'/u);
    assert.match(workflow, /ref: \$\{\{ github\.workflow_sha \}\}/u);
    assert.match(workflow, /path: smoke-tools/u);
    assert.match(workflow, /This ref predates the packaged import-smoke capability/u);
    assert.match(workflow, /Historical ref has no compatible packaged import-smoke mode/u);
    assert.match(workflow, /release-smoke-artifact\/release\/windows-import-smoke\.json/u);
    assert.match(workflow, /electron-v\$version-win32-\$\{\{ matrix\.arch \}\}\.zip/u);
    assert.match(workflow, /Get-FileHash .* -Algorithm SHA256/u);
    assert.match(workflow, /-HarnessElectron .*electron-harness\/dist\/electron\.exe/u);
    const installedJob = workflow.slice(workflow.indexOf('  installed-windows-import:'));
    assert.doesNotMatch(installedJob, /actions\/setup-node/u);
    assert.doesNotMatch(installedJob, /npm (?:ci|install)/u);
    assert.doesNotMatch(installedJob, /cache: npm/u);
    assert.doesNotMatch(installedJob, /ref: \$\{\{ inputs\.ref \}\}/u);
    assert.match(smoke, /ProcessArchitecture/u);
    assert.match(smoke, /installedArchive[\s\S]*app\.asar/u);
    assert.match(smoke, /ArgumentList\.Add\(\$installedArchive\)/u);
    assert.match(smoke, /OVERLOOK_RELEASE_IMPORT_SMOKE_HARNESS/u);
    assert.match(smoke, /\$smokeExecutable = \$harnessElectronPath/u);
    assert.match(smoke, /--overlook-release-import-smoke/u);
    assert.match(smoke, /ArgumentList\.Add\("--overlook-release-import-source=\$fixturePath"\)/u);
    assert.match(smoke, /ArgumentList\.Add\("--overlook-release-import-profile=\$profile"\)/u);
    assert.match(smoke, /ArgumentList\.Add\("--overlook-release-import-result=\$resultPath"\)/u);
    assert.match(smoke, /overlook-release-import-smoke:ready/u);
    assert.match(smoke, /Remove-Item -LiteralPath \$profile -Recurse -Force/u);
  });

  test('the x64 package proves native ACL and complete installer lifecycle behavior', () => {
    const workflow = source('.github/workflows/package.yml');
    const installer = source('build/installer.nsh');
    const smoke = source('scripts/verify-windows-live-local-install.ps1');
    assert.match(workflow, /node native\/windows-interop\/install\.cjs "\$WIN_ARCH"/u);
    assert.match(workflow, /node native\/windows-interop\/test\.cjs/u);
    assert.match(workflow, /pwsh -NoProfile -File scripts\/verify-windows-live-local-install\.ps1/u);
    assert.match(installer, /!macro customUnInstall/u);
    assert.match(installer, /--unregister-native-host/u);
    assert.match(smoke, /--register-native-host/u);
    assert.match(smoke, /--unregister-native-host/u);
    assert.match(smoke, /Windows live-local install, upgrade, disable, and uninstall smoke passed/u);
  });

  test('historical refs skip only an undeclared Windows interop component', () => {
    const workflow = source('.github/workflows/package.yml');
    assert.match(workflow, /Object\.hasOwn\([\s\S]*optionalDependencies[\s\S]*"@overlook\/windows-interop"\)/u);
    assert.match(workflow, /echo "HAS_WINDOWS_INTEROP=\$has_windows_interop" >> "\$GITHUB_ENV"/u);
    assert.match(workflow, /if \[ "\$HAS_WINDOWS_INTEROP" = true \]; then/u);
    assert.match(workflow, /test -f native\/windows-interop\/install\.cjs/u);
    assert.match(workflow, /test -f native\/windows-interop\/test\.cjs/u);
    assert.match(workflow, /elif \[ -e native\/windows-interop \]; then/u);
    assert.match(workflow, /Windows interop source exists without its optional dependency declaration/u);
    assert.match(workflow, /This ref predates the optional Windows interop component/u);
    assert.match(workflow, /if \[ "\$WIN_ARCH" = "x64" \] && \[ "\$HAS_WINDOWS_INTEROP" = true \]; then/u);
    assert.match(workflow, /test -f scripts\/verify-windows-live-local-install\.ps1/u);
    assert.match(workflow, /Windows interop lifecycle smoke exists without its optional component/u);
    assert.match(workflow, /This ref predates the optional Windows interop lifecycle smoke/u);
  });

  test('SQLite v13 foreign prebuilds are pruned before Windows architecture verification', () => {
    const workflow = source('.github/workflows/package.yml');
    const builder = source('electron-builder.yml');
    const pruner = source('scripts/prune-foreign-binaries.mjs');
    assert.match(builder, /afterPack: scripts\/prune-foreign-binaries\.mjs/u);
    assert.match(pruner, /node_modules\/better-sqlite3-multiple-ciphers\/prebuilds/u);
    assert.match(pruner, /const FLAT_PREBUILD_NAME/u);
    assert.match(pruner, /flatPrebuildTarget\(entry\.name\)/u);
    assert.ok(workflow.indexOf('npm run "dist:win:$WIN_ARCH"') < workflow.indexOf('node scripts/verify-windows-arch.mjs'));
  });

  test('packaging preserves reviewed Node-API binaries rather than rebuilding SQLite source metadata', () => {
    const packageJson = JSON.parse(source('package.json')) as { readonly scripts?: Record<string, string> };
    const builder = source('electron-builder.yml');
    assert.doesNotMatch(packageJson.scripts?.['postinstall'] ?? '', /install-app-deps/u);
    assert.match(builder, /npmRebuild: false/u);
    assert.match(builder, /Every shipped native dependency is Node-API or a loadable/u);
  });

  test('the NSIS payload uses a filter the installer can actually decode', () => {
    const workflow = source('.github/workflows/package.yml');
    // electron-builder's downloaded 7-Zip 24.x auto-applies its ARM64 branch
    // filter (method 0A) to ARM64 binaries, but the nsis7z plugin unpacking
    // the payload at install time predates that filter and silently skips
    // every file using it -- shipping an arm64 installer that installed
    // everything except Overlook.exe and 10 ARM64 DLLs (#683). Pinning an
    // older filter keeps the payload decodable; extracted bytes are identical.
    assert.match(workflow, /export ELECTRON_BUILDER_7Z_FILTER=BCJ2/u);
  });

  test('cross-compiled legs lock, verify, and isolate the target sharp binary', () => {
    const workflow = source('.github/workflows/package.yml');
    // npm ci installs only the host sharp binary; the arm64 leg must pull the
    // target-arch @img/sharp-win32-<arch> and prune the rest, or a mixed
    // payload would ship (and fail verify-windows-arch). Uses npm pack + extract
    // (not `npm install --cpu/--os`, which would prune the host build toolchain).
    assert.match(workflow, /npm pack "@img\/\$pkg@\$sharp_ver"/u);
    assert.match(workflow, /require\("\.\/package-lock\.json"\)\.packages/u);
    assert.match(workflow, /locked\.version !== version/u);
    assert.match(workflow, /createHash\("sha512"\)/u);
    assert.match(workflow, /actual !== locked\.integrity/u);
    assert.ok(workflow.indexOf('actual !== locked.integrity') < workflow.indexOf('tar -xzf "$tgz"'));
    assert.doesNotMatch(workflow, /npm install --no-save --cpu="\$WIN_ARCH" --os=win32 sharp/u);
    assert.match(workflow, /find node_modules\/@img .* -name 'sharp-win32-\*' ! -name "\$pkg"/u);
  });

  test('Windows signing uses Azure Trusted Signing, isolated from the mac certificate', () => {
    const workflow = source('.github/workflows/package.yml');
    const builder = source('electron-builder.yml');
    // Separate secrets: the Azure service principal, never the mac CSC_*.
    assert.match(workflow, /AZURE_TENANT_ID: \$\{\{ runner\.os == 'Windows' && secrets\.AZURE_TENANT_ID \|\| '' \}\}/u);
    assert.match(workflow, /AZURE_CLIENT_ID: \$\{\{ runner\.os == 'Windows' && secrets\.AZURE_CLIENT_ID \|\| '' \}\}/u);
    assert.match(workflow, /AZURE_CLIENT_SECRET: \$\{\{ runner\.os == 'Windows' && secrets\.AZURE_CLIENT_SECRET \|\| '' \}\}/u);
    assert.match(workflow, /unset CSC_LINK CSC_KEY_PASSWORD/u);
    // The Windows branch is its own arm.
    assert.match(workflow, /elif \[ "\$RUNNER_OS" = "Windows" \]; then/u);
    // Azure Trusted Signing has no opportunistic-cert fallback, so the full
    // service principal's absence must force it off via CLI override rather
    // than let electron-builder fail the build outright. Gated on all three
    // secrets, not just AZURE_TENANT_ID, so a partially-configured principal
    // doesn't get mislabeled as signed.
    const azureGate = 'if [ -n "$AZURE_TENANT_ID" ] && [ -n "$AZURE_CLIENT_ID" ] && [ -n "$AZURE_CLIENT_SECRET" ]; then';
    assert.strictEqual(workflow.split(azureGate).length - 1, 2);
    // The override is applied to a direct electron-builder invocation, not
    // routed through the compound package:win:* npm script -- `npm run x --
    // args` appends args to the whole script rather than the electron-builder
    // call inside it.
    assert.match(workflow, /npx --no-install electron-builder --publish never --win --"\$WIN_ARCH" \\\s+-c\.win\.azureSignOptions=null/u);
    // Signature verification is guarded by secret presence and targets the
    // arch-qualified installer(s). Get-AuthenticodeSignature, not signtool.exe
    // -- the latter ships with the Windows SDK but isn't on windows-latest's
    // PATH, while Get-AuthenticodeSignature is a builtin PowerShell cmdlet.
    assert.match(workflow, /for installer in release\/Overlook-\*-"\$WIN_ARCH"\.exe; do/u);
    assert.match(workflow, /Get-AuthenticodeSignature -FilePath '\$installer'/u);
    assert.match(workflow, /if \(\\\$sig\.Status -ne 'Valid'\) \{ exit 1 \}/u);
    assert.doesNotMatch(workflow, /signtool verify/u);
    // electron-builder.yml carries the Trusted Signing account coordinates,
    // never a local certificate.
    assert.match(builder, /azureSignOptions:/u);
    assert.match(builder, /publisherName:/u);
    assert.match(builder, /endpoint:/u);
    assert.match(builder, /codeSigningAccountName:/u);
    assert.match(builder, /certificateProfileName:/u);
    assert.doesNotMatch(builder, /signtoolOptions:/u);
    assert.doesNotMatch(builder, /certificateFile:/u);
    assert.doesNotMatch(builder, /certificatePassword:/u);
  });

  test('release asset labels use the Windows signing gate independently', () => {
    const release = source('.github/workflows/release.yml');
    assert.match(
      release,
      /WINDOWS_SIGNED: \$\{\{ secrets\.AZURE_TENANT_ID != '' && secrets\.AZURE_CLIENT_ID != '' && secrets\.AZURE_CLIENT_SECRET != '' \}\}/u,
    );
    assert.match(release, /if \[ "\$WINDOWS_SIGNED" = "true" \]; then status=signed; else status=unsigned; fi/u);
  });
});
