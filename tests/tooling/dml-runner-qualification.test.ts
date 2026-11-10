import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
const job = workflow.split('  dml-arm64-qualification:\n')[1]?.split('\n  windows-main-smoke:')[0];
assert.ok(job);
const condition = job.match(/ {4}if: >-\n([\s\S]*?)\n {4}runs-on:/u)?.[1]?.trim();
assert.ok(condition);

for (const policyResult of ['success', 'failure', 'cancelled', 'skipped']) {
  for (const runFull of ['true', 'false', '']) {
    for (const runnerEnabled of ['true', 'false', '']) {
      for (const cancelled of [false, true]) {
        test(`DML runner selection: policy=${policyResult}, full=${runFull}, runner=${runnerEnabled}, cancelled=${String(cancelled)}`, () => {
          const selected: unknown = runInNewContext(condition, {
            cancelled: () => cancelled,
            needs: { policy: { result: policyResult, outputs: { run_full: runFull } } },
            vars: { OVERLOOK_DML_ARM64_RUNNER: runnerEnabled },
          });
          assert.equal(selected, policyResult === 'success' && runFull === 'true' && runnerEnabled === 'true' && !cancelled);
        });
      }
    }
  }
}

const gate = workflow.split('  gate:\n')[1];
assert.ok(gate);
const script = gate
  .split('      - name: Enforce the selected lifecycle lane\n')[1]
  ?.split('        run: |\n')[1]
  ?.split('\n      - name:')[0];
assert.ok(script);

for (const mode of ['full', 'queue', 'manual']) {
  for (const preflight of ['true', 'false']) {
    for (const enabled of ['true', 'false']) {
      for (const result of ['success', 'failure', 'cancelled', 'skipped', '']) {
        test(`DML required gate: mode=${mode}, preflight=${preflight}, enabled=${enabled}, hardware=${result}`, () => {
          const verdict = spawnSync('bash', ['-e', '-c', script], {
            encoding: 'utf8',
            env: {
              ...process.env,
              MODE: mode,
              POLICY: 'success',
              WORKFLOW_RUNTIME: 'success',
              COMPLETE: 'success',
              WINDOWS_TESTS: 'success',
              E2E_GATE: 'success',
              DOCS_GOV: 'success',
              CODEQL: 'success',
              PREFLIGHT: 'success',
              PREFLIGHT_VALIDATED: preflight,
              DML_ARM64_ENABLED: enabled,
              DML_ARM64: result,
            },
          });
          assert.ifError(verdict.error);
          const expected = enabled === 'true' ? 'success' : 'skipped';
          assert.equal(verdict.status === 0, result === expected, verdict.stderr);
        });
      }
    }
  }
}

test('DML hardware qualification is required when enabled and retains native strict controls', () => {
  assert.doesNotMatch(workflow, /qualify_dml_arm64/u);
  assert.match(gate, /needs:[\s\S]*?dml-arm64-qualification,/u);
  assert.match(gate, /DML_ARM64: \$\{\{ needs\.dml-arm64-qualification\.result \}\}/u);
  assert.match(gate, /DML_ARM64_ENABLED: \$\{\{ vars\.OVERLOOK_DML_ARM64_RUNNER == 'true' \}\}/u);
  assert.match(job, /needs: policy/u);
  assert.match(job, /runs-on: \[self-hosted, Windows, ARM64\]/u);
  assert.match(job, /persist-credentials: false/u);
  assert.doesNotMatch(job, /git config --global/u);
  assert.match(job, /GIT_CONFIG_COUNT: '1'/u);
  assert.match(job, /GIT_CONFIG_KEY_0: core\.autocrlf/u);
  assert.match(job, /GIT_CONFIG_VALUE_0: 'false'/u);
  assert.match(job, /git config --show-scope --get core\.autocrlf/u);
  assert.match(job, /architecture: arm64/u);
  assert.match(job, /node scripts\/assert-platform\.mjs win32 arm64/u);
  assert.match(job, /run: npm run test:embedding-native:inner/u);
  assert.match(job, /OVERLOOK_DML_QUALIFICATION: '1'/u);
  const tests = readFileSync('tests/embedding/native-worker.test.ts', 'utf8');
  assert.match(tests, /CPU rejection with fallback disabled/u);
  assert.match(tests, /CPU fallback cannot qualify a platform accelerator/u);
});
