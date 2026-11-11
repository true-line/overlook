import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { sign } from '@electron/osx-sign';

const EXTENSION_BUNDLE = `${path.sep}OverlookFileProvider.appex${path.sep}`;
const QUICK_LOOK_BUNDLE = `${path.sep}OverlookQuickLook.appex${path.sep}`;
const FILE_PROVIDER_APPLICATION_ID = 'Z5DM34QS5U.com.zts1.overlook.file-provider';

function isFileProviderExtension(filePath) {
  return filePath.includes(EXTENSION_BUNDLE) || filePath.endsWith(`${path.sep}OverlookFileProvider.appex`);
}

function isQuickLookExtension(filePath) {
  return filePath.includes(QUICK_LOOK_BUNDLE) || filePath.endsWith(`${path.sep}OverlookQuickLook.appex`);
}

function extensionEntitlements(filePath) {
  if (isFileProviderExtension(filePath)) return path.resolve('native/file-provider-extension/entitlements.plist');
  if (isQuickLookExtension(filePath)) return path.resolve('native/quick-look-extension/entitlements.plist');
  return null;
}

function requiredEntitlements(configuration, filePath) {
  const entitlements = configuration.optionsForFile?.(filePath)?.entitlements;
  if (typeof entitlements !== 'string' || entitlements === '') {
    throw new Error(`entitlements are missing for ${path.basename(filePath)}`);
  }
  return entitlements;
}

export function nestedCodeSignArguments(configuration, bundlePath, entitlements) {
  if (configuration.identity === undefined || configuration.identity === '') {
    throw new Error(`signing identity is required for ${path.basename(bundlePath)}`);
  }
  const options = configuration.optionsForFile?.(bundlePath) ?? {};
  const args = ['--sign', configuration.identity, '--force'];
  if (configuration.keychain !== undefined) args.push('--keychain', configuration.keychain);
  args.push(options.timestamp === undefined ? '--timestamp' : `--timestamp=${options.timestamp}`);

  const signatureFlags = Array.isArray(options.signatureFlags)
    ? [...options.signatureFlags]
    : (options.signatureFlags?.split(',').map((flag) => flag.trim()) ?? []);
  if (options.hardenedRuntime === true && !signatureFlags.includes('runtime')) signatureFlags.push('runtime');
  if (signatureFlags.length > 0) args.push('--options', [...new Set(signatureFlags)].join(','));
  if (options.requirements !== undefined) {
    if (options.requirements.startsWith('=')) args.push(`-r${options.requirements}`);
    else args.push('--requirements', options.requirements);
  }
  if (options.additionalArguments !== undefined) args.push(...options.additionalArguments);
  args.push('--entitlements', entitlements, bundlePath);
  return args;
}

const TRANSIENT_TIMESTAMP_ERROR =
  /timestamp was expected but was not found|timestamp service is not available|unable to communicate with the timestamp service/iu;

function errorText(error) {
  if (error === null || error === undefined) return '';
  if (typeof error === 'string') return error;
  if (typeof error !== 'object') return '';
  const parts = [];
  if (typeof error.message === 'string') parts.push(error.message);
  if (typeof error.stderr === 'string') parts.push(error.stderr);
  else if (Buffer.isBuffer(error.stderr)) parts.push(error.stderr.toString('utf8'));
  if (typeof error.stdout === 'string') parts.push(error.stdout);
  else if (Buffer.isBuffer(error.stdout)) parts.push(error.stdout.toString('utf8'));
  return parts.join('\n');
}

export function isTransientTimestampError(error) {
  return TRANSIENT_TIMESTAMP_ERROR.test(errorText(error));
}

function defaultSleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function defaultSleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export async function withTimestampRetry(operation, { attempts = 4, baseDelayMs = 2000, sleep = defaultSleep } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= attempts || !isTransientTimestampError(error)) throw error;
      const delayMs = baseDelayMs * 2 ** (attempt - 1);
      process.stderr.write(`codesign timestamp transient failure (attempt ${attempt}/${attempts}); retrying in ${delayMs}ms...\n`);
      await sleep(delayMs);
    }
  }
}

function forwardCapturedOutput(error) {
  if (error === null || error === undefined || typeof error !== 'object') return;
  if (typeof error.stdout === 'string' && error.stdout !== '') process.stdout.write(error.stdout);
  else if (Buffer.isBuffer(error.stdout) && error.stdout.length > 0) process.stdout.write(error.stdout);
  if (typeof error.stderr === 'string' && error.stderr !== '') process.stderr.write(error.stderr);
  else if (Buffer.isBuffer(error.stderr) && error.stderr.length > 0) process.stderr.write(error.stderr);
}

export function signNestedBundle(
  configuration,
  bundlePath,
  entitlements,
  run = execFileSync,
  { attempts = 4, baseDelayMs = 2000, sleepSync = defaultSleepSync } = {},
) {
  const args = nestedCodeSignArguments(configuration, bundlePath, entitlements);
  for (let attempt = 1; ; attempt += 1) {
    try {
      const output = run('codesign', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      if (typeof output === 'string' && output !== '') process.stdout.write(output);
      return;
    } catch (error) {
      forwardCapturedOutput(error);
      if (attempt >= attempts || !isTransientTimestampError(error)) throw error;
      const delayMs = baseDelayMs * 2 ** (attempt - 1);
      process.stderr.write(
        `codesign timestamp transient failure on ${path.basename(bundlePath)} (attempt ${attempt}/${attempts}); retrying in ${delayMs}ms...\n`,
      );
      sleepSync(delayMs);
    }
  }
}

export function abstractStringEntitlement(source, key) {
  const marker = `[Key] ${key}`;
  const start = source.indexOf(marker);
  if (start < 0) return null;
  const next = source.indexOf('\n\t[Key] ', start + marker.length);
  const block = source.slice(start, next < 0 ? undefined : next);
  return /\[String\] ([^\n]+)/u.exec(block)?.[1]?.trim() ?? null;
}

function verifyFileProviderIdentity(bundlePath, run = execFileSync) {
  const entitlements = String(run('codesign', ['-d', '--entitlements', '-', bundlePath], { encoding: 'utf8' }));
  if (abstractStringEntitlement(entitlements, 'com.apple.application-identifier') !== FILE_PROVIDER_APPLICATION_ID) {
    throw new Error(`signed File Provider extension lacks application identifier ${FILE_PROVIDER_APPLICATION_ID}`);
  }
}

export default async function signMacApp(configuration) {
  const extension = path.join(configuration.app, 'Contents', 'PlugIns', 'OverlookFileProvider.appex');
  const quickLook = path.join(configuration.app, 'Contents', 'PlugIns', 'OverlookQuickLook.appex');
  const nestedExtensions = [extension, quickLook].filter(existsSync);
  for (const bundlePath of nestedExtensions) {
    const entitlements = extensionEntitlements(bundlePath);
    if (entitlements === null) throw new Error(`entitlements are missing for ${path.basename(bundlePath)}`);
    // An appex is a code bundle, not an additional binary. Sign it explicitly
    // before the containing app so its profile-bound identity survives the
    // outer seal and notarization.
    signNestedBundle(configuration, bundlePath, entitlements);
    if (bundlePath === extension) verifyFileProviderIdentity(extension);
  }
  await withTimestampRetry(() =>
    sign({
      ...configuration,
      batchCodesignCalls: configuration.batchCodesignCalls ?? true,
      // Profiles are embedded and validated by our provisioned packaging path.
      // osx-sign has only one profile input and would otherwise apply the main
      // app profile while auto-processing the separately identified extension.
      ...(nestedExtensions.length > 0
        ? { provisioningProfile: undefined, preEmbedProvisioningProfile: false, preAutoEntitlements: false }
        : {}),
    }),
  );
  if (nestedExtensions.length > 0) {
    // electron-builder's signer owns every other nested code item. Re-apply
    // these separately identified bundles after that pass, then re-seal only
    // the containing app so the final signature is deterministically inside-out.
    for (const bundlePath of nestedExtensions) {
      const entitlements = extensionEntitlements(bundlePath);
      if (entitlements === null) throw new Error(`entitlements are missing for ${path.basename(bundlePath)}`);
      signNestedBundle(configuration, bundlePath, entitlements);
    }
    signNestedBundle(configuration, configuration.app, requiredEntitlements(configuration, configuration.app));
    execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', configuration.app], { stdio: 'inherit' });
    if (existsSync(extension)) verifyFileProviderIdentity(extension);
  }
}
