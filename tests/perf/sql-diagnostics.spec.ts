import { execFileSync } from 'node:child_process';

import { test } from '@playwright/test';

// Additional attribution only; existing application assertions remain intact.
if (process.env['OVERLOOK_PERF_PROFILE'] === '1') {
  test('diagnostic 200K SQL: cache pressure, covering reads and vector join order', () => {
    execFileSync(process.execPath, ['.test-dist/tests/perf/sql-diagnostics.js'], {
      stdio: 'inherit',
      timeout: 540_000,
    });
  });
}
