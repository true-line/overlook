#!/usr/bin/env node

import { spawn } from 'node:child_process';
import electron from 'electron';
import { pathToFileURL } from 'node:url';

export function electronTestEnvironment(environment = process.env) {
  return { ...environment, ELECTRON_RUN_AS_NODE: '1' };
}

// Shipped desktop targets (macOS, Windows) execute unit tests inside Electron's
// Node runtime (#72). Hosted Linux CI is not a shipped target, and Ubuntu 26.04+
// maps system GLib 2.86 via Electron's ELF DT_NEEDED without GTK initialization
// under ELECTRON_RUN_AS_NODE=1 — colliding with @img/sharp-libvips-linux-*'s
// bundled GLib (SharpElectronLinux SIGSEGV). Linux unit/coverage runs use the
// .nvmrc Node binary while the Xvfb E2E lane proves full Electron + sharp.
export function unitTestExecutable(platform = process.platform, nodeExecutable = process.execPath) {
  return platform === 'linux' ? nodeExecutable : electron;
}

export function runElectronNodeTest(patterns, spawnProcess = spawn, platform = process.platform) {
  if (patterns.length === 0) throw new Error('usage: run-electron-node-test.mjs <test-pattern> [test-pattern...]');
  const executable = unitTestExecutable(platform);
  return new Promise((resolve, reject) => {
    const child = spawnProcess(executable, ['--test', ...patterns], {
      stdio: 'inherit',
      env: platform === 'linux' ? { ...process.env } : electronTestEnvironment(),
      shell: false,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

async function main() {
  const result = await runElectronNodeTest(process.argv.slice(2));
  if (result.signal !== null) {
    process.kill(process.pid, result.signal);
    return;
  }
  process.exitCode = result.code ?? 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
