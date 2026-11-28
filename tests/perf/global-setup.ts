import { execFileSync } from 'node:child_process';

import e2eGlobalSetup from '../e2e/global-setup.js';

/** Performance budgets measure a visible native window, including frame delivery. */
export function configurePerfEnvironment(): void {
  process.env['OVERLOOK_E2E_VISIBLE'] = '1';
}

export default function perfGlobalSetup(): void {
  configurePerfEnvironment();
  e2eGlobalSetup();
  if (process.env['OVERLOOK_PERF_PROFILE'] === '1') {
    // SQL attribution runs outside Playwright's declaration-only path mappings.
    // Compilation is setup work, before any application/query measurement.
    execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.test.json'], { stdio: 'inherit' });
  }
}
