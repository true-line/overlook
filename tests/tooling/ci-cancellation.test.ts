import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
const workers = ['ci', 'windows-tests', 'e2e', 'docs-gov', 'codeql'] as const;

function jobSource(name: string): string {
  const body = workflow.split(`\n  ${name}:\n`)[1];
  assert.notEqual(body, undefined, `missing job ${name}`);
  return (body ?? '').split(/\n {2}[a-z][\w-]*:\n/u)[0] ?? '';
}

function condition(name: string): string {
  const source = jobSource(name);
  const expression = / {4}if: >-\n((?: {6}.+\n)+)/u.exec(source)?.[1];
  assert.ok(expression, `missing folded condition for ${name}`);
  // GitHub permits hyphens in property names; JavaScript requires brackets.
  return expression.replace(/needs\.([\w-]+)/gu, 'needs["$1"]');
}

function runs(name: string, full: boolean, postMerge: boolean, validated: boolean, cancelled = false, policy = 'success'): boolean {
  const value: unknown = runInNewContext(condition(name), {
    cancelled: () => cancelled,
    needs: {
      policy: { result: policy, outputs: { run_full: String(full), run_post_merge: String(postMerge) } },
      'preflight-evidence': { result: full ? 'success' : 'skipped', outputs: { validated: String(validated) } },
      'merge-evidence': { result: postMerge ? 'success' : 'skipped', outputs: { validated: String(validated) } },
    },
  });
  assert.equal(typeof value, 'boolean');
  return value === true;
}

test('worker predicates retain required work across intentionally skipped dependencies', () => {
  for (const worker of workers) {
    assert.equal(runs(worker, true, false, false), true, `${worker}: ordinary PR/manual/full run`);
    assert.equal(runs(worker, true, false, true), false, `${worker}: exact preflight reused`);
    assert.equal(runs(worker, false, true, false), worker !== 'windows-tests', `${worker}: post-merge fallback`);
    assert.equal(runs(worker, false, true, true), worker === 'codeql', `${worker}: validated merge still needs CodeQL`);
    assert.equal(runs(worker, false, false, false), false, `${worker}: no authorized work`);
    assert.equal(runs(worker, true, false, false, false, 'failure'), false, `${worker}: failed policy`);
  }
});

test('cancelled workflows stop worker jobs regardless of previously satisfied conditions', () => {
  for (const worker of workers) {
    for (const [full, postMerge, validated] of [
      [true, false, false],
      [true, false, true],
      [false, true, false],
      [false, true, true],
    ]) {
      assert.equal(runs(worker, full ?? false, postMerge ?? false, validated ?? false, true), false, worker);
    }
  }
});

test('failed evidence lookup still runs fallback work instead of implicitly skipping it', () => {
  for (const worker of workers) {
    for (const result of ['failure', 'skipped', 'cancelled']) {
      const value: unknown = runInNewContext(condition(worker), {
        cancelled: () => false,
        needs: {
          policy: { result: 'success', outputs: { run_full: 'true', run_post_merge: 'false' } },
          'preflight-evidence': { result, outputs: {} },
          'merge-evidence': { result: 'skipped', outputs: {} },
        },
      });
      assert.equal(value, true, `${worker}: ${result} lookup without validated evidence`);
    }
  }
});

const gate = jobSource('gate');
const script = gate
  .split('        run: |\n')[1]
  ?.split('\n      - name:')[0]
  ?.replace(/^ {10}/gmu, '');
assert.ok(script, 'aggregate gate script must exist');
const success = {
  POLICY: 'success',
  WORKFLOW_RUNTIME: 'success',
  MODE: 'full',
  PREFLIGHT: 'skipped',
  PREFLIGHT_VALIDATED: 'false',
  MERGE_VALIDATED: 'false',
  COMPLETE: 'success',
  WINDOWS_TESTS: 'success',
  DML_ARM64: 'success',
  DML_ARM64_ENABLED: 'true',
  WINDOWS_MAIN: 'success',
  E2E_GATE: 'success',
  DOCS_GOV: 'success',
  CODEQL: 'success',
  POST_MERGE: 'success',
};
function verdict(overrides: Record<string, string>): number | null {
  const cancelled = overrides['CANCELLED'] === 'true';
  const reject = /name: Reject cancelled workflow\n {8}if: \$\{\{ cancelled\(\) \}\}\n {8}run: (.+)/u.exec(gate)?.[1];
  assert.ok(reject);
  const lateReject = /name: Reject cancellation after verdict\n {8}if: \$\{\{ cancelled\(\) \}\}\n {8}run: (.+)/u.exec(gate)?.[1];
  assert.ok(lateReject);
  const command = cancelled ? reject : overrides['CANCELLED_AFTER_VERDICT'] === 'true' ? `${script}\n${lateReject}` : script;
  return spawnSync('bash', ['-e', '-c', command ?? 'exit 99'], { env: { ...process.env, ...success, ...overrides } }).status;
}

test('aggregate verdict fails closed for cancelled workflows and required jobs', () => {
  assert.match(gate, /if: always\(\)/u);
  assert.match(jobSource('e2e-gate'), /always\(\)/u);
  assert.ok(gate.indexOf('Reject cancellation after verdict') > gate.indexOf('Enforce the selected lifecycle lane'));
  assert.match(gate.trimEnd(), /name: Reject cancellation after verdict[\s\S]*run: exit 1$/u);
  // Status functions are valid in step conditions, not in env expressions.
  assert.match(gate, /name: Enforce the selected lifecycle lane\n {8}if: \$\{\{ !cancelled\(\) \}\}/u);
  assert.doesNotMatch(gate, /[A-Z_]+: \$\{\{ (?:cancelled|always|success|failure)\(\)/u);
  for (const MODE of ['full', 'manual', 'queue', 'post-merge']) {
    assert.equal(verdict({ MODE }), 0, MODE);
    assert.notEqual(verdict({ MODE, CANCELLED: 'true' }), 0, MODE);
    assert.notEqual(verdict({ MODE, CANCELLED_AFTER_VERDICT: 'true' }), 0, `${MODE}: cancellation after a successful verdict`);
    for (const result of ['failure', 'cancelled', 'skipped', '']) {
      assert.notEqual(verdict({ MODE, COMPLETE: result }), 0, `${MODE}: ${result}`);
    }
  }
  assert.equal(verdict({ PREFLIGHT: 'success', PREFLIGHT_VALIDATED: 'true', COMPLETE: 'skipped' }), 0);
  for (const MODE of ['full', 'manual', 'queue']) {
    for (const DML_ARM64 of ['failure', 'cancelled', 'skipped', '']) {
      assert.notEqual(verdict({ MODE, DML_ARM64 }), 0, `${MODE}: DirectML ${DML_ARM64}`);
    }
    assert.equal(verdict({ MODE, DML_ARM64_ENABLED: 'false', DML_ARM64: 'skipped' }), 0, `${MODE}: DirectML skipped when runner absent`);
    for (const DML_ARM64 of ['failure', 'cancelled', 'success', '']) {
      assert.notEqual(verdict({ MODE, DML_ARM64_ENABLED: 'false', DML_ARM64 }), 0, `${MODE}: DirectML ${DML_ARM64} when runner absent`);
    }
  }
  assert.notEqual(verdict({ PREFLIGHT: 'success', PREFLIGHT_VALIDATED: 'true', DML_ARM64: 'skipped' }), 0);
  assert.notEqual(verdict({ PREFLIGHT: 'cancelled', PREFLIGHT_VALIDATED: 'true' }), 0);
  assert.notEqual(verdict({ CANCELLED: 'true', PREFLIGHT: 'success', PREFLIGHT_VALIDATED: 'true' }), 0);
});
