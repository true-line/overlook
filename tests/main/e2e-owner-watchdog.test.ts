import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OWNER_PID_ENV,
  OWNER_POLL_MS,
  OWNER_START_ENV,
  ownerGone,
  processExists,
  processStartIdentity,
  resolveOwnerWatch,
  startE2eOwnerWatchdog,
  type OwnerWatchdogDeps,
} from '../../src/main/e2e-owner-watchdog.js';

interface Harness {
  readonly deps: OwnerWatchdogDeps;
  readonly tick: () => void;
  readonly exits: () => number;
  readonly intervals: number[];
  setParent: (pid: number) => void;
  setAlive: (alive: boolean) => void;
  setStart: (start: string | undefined) => void;
  unrefCalls: () => number;
}

function harness(env: Record<string, string | undefined>, options: { packaged?: boolean; parent?: number } = {}): Harness {
  let parent = options.parent ?? 4242;
  let alive = true;
  let start: string | undefined = 'linux:100';
  let exitCount = 0;
  let unrefs = 0;
  let scheduled: (() => void) | undefined;
  const intervals: number[] = [];
  const deps: OwnerWatchdogDeps = {
    packaged: options.packaged ?? false,
    env,
    parentPid: () => parent,
    isAlive: () => alive,
    startIdentity: () => start,
    exit: () => {
      exitCount += 1;
    },
    schedule: (tick, intervalMs) => {
      scheduled = tick;
      intervals.push(intervalMs);
      return {
        unref: () => {
          unrefs += 1;
        },
      };
    },
  };
  return {
    deps,
    tick: () => scheduled?.(),
    exits: () => exitCount,
    intervals,
    setParent: (pid) => {
      parent = pid;
    },
    setAlive: (value) => {
      alive = value;
    },
    setStart: (value) => {
      start = value;
    },
    unrefCalls: () => unrefs,
  };
}

test('owner watchdog is off outside an unpackaged E2E harness launch', () => {
  assert.equal(startE2eOwnerWatchdog(harness({}).deps), null);
  assert.equal(startE2eOwnerWatchdog(harness({ OVERLOOK_E2E: '0' }).deps), null);
  assert.equal(startE2eOwnerWatchdog(harness({ OVERLOOK_E2E: '1' }, { packaged: true }).deps), null);
});

test('a launch whose worker died mid-startup (already parented to init) exits on the first tick', () => {
  const env: Record<string, string | undefined> = { OVERLOOK_E2E: '1' };
  const run = harness(env, { parent: 1 });
  assert.deepEqual(startE2eOwnerWatchdog(run.deps), { ownerPid: 1, directChild: true });
  assert.equal(env[OWNER_PID_ENV], undefined, 'init is never recorded as the owner for a relaunched successor');
  assert.equal(env[OWNER_START_ENV], undefined);
  run.tick();
  assert.equal(run.exits(), 1);
});

test('the first launch is owned by its parent and records it for relaunched successors', () => {
  const env: Record<string, string | undefined> = { OVERLOOK_E2E: '1' };
  const watch = resolveOwnerWatch(harness(env).deps);
  assert.deepEqual(watch, { ownerPid: 4242, directChild: true, ownerStart: 'linux:100' });
  assert.equal(env[OWNER_PID_ENV], '4242');
  assert.equal(env[OWNER_START_ENV], 'linux:100');
});

test('an app.relaunch successor follows the original worker, not its dead predecessor', () => {
  const successor = harness({ OVERLOOK_E2E: '1', [OWNER_PID_ENV]: '4242', [OWNER_START_ENV]: 'linux:100' }, { parent: 9001 });
  const watch = startE2eOwnerWatchdog(successor.deps);
  assert.deepEqual(watch, { ownerPid: 4242, directChild: false, ownerStart: 'linux:100' });
  // The predecessor exiting reparents the successor; that alone must not fire.
  successor.setParent(1);
  successor.tick();
  assert.equal(successor.exits(), 0);
  successor.setAlive(false);
  successor.tick();
  assert.equal(successor.exits(), 1);
});

test('the app exits once when its worker is SIGKILLed (reparented to init)', () => {
  const run = harness({ OVERLOOK_E2E: '1' });
  assert.notEqual(startE2eOwnerWatchdog(run.deps), null);
  assert.deepEqual(run.intervals, [OWNER_POLL_MS]);
  assert.equal(run.unrefCalls(), 1, 'the poll timer must never hold the process open');
  run.tick();
  assert.equal(run.exits(), 0, 'a live owner keeps the app running');
  run.setParent(1);
  run.tick();
  run.tick();
  assert.equal(run.exits(), 1);
});

test("a successor exits when the dead worker's pid is reused by another process", () => {
  const successor = harness({ OVERLOOK_E2E: '1', [OWNER_PID_ENV]: '4242', [OWNER_START_ENV]: 'linux:100' }, { parent: 1 });
  startE2eOwnerWatchdog(successor.deps);
  successor.tick();
  assert.equal(successor.exits(), 0);
  // The worker died and an unrelated process took pid 4242 before the next poll.
  successor.setStart('linux:250');
  successor.tick();
  assert.equal(successor.exits(), 1);
});

test('an unreadable start time falls back to the liveness probe instead of exiting', () => {
  const watch = { ownerPid: 4242, directChild: false, ownerStart: 'ps:Mon Nov 16 09:00:00 2026' };
  const deps = (alive: boolean) => ({ parentPid: () => 1, isAlive: () => alive, startIdentity: () => undefined });
  assert.equal(ownerGone(watch, deps(true)), false);
  assert.equal(ownerGone(watch, deps(false)), true);
});

test('a vanished owner is detected even without reparenting (Windows has none)', () => {
  const watch = { ownerPid: 4242, directChild: true };
  const start = () => undefined;
  assert.equal(ownerGone(watch, { parentPid: () => 4242, isAlive: () => true, startIdentity: start }), false);
  assert.equal(ownerGone(watch, { parentPid: () => 4242, isAlive: () => false, startIdentity: start }), true);
  assert.equal(ownerGone(watch, { parentPid: () => 77, isAlive: () => true, startIdentity: start }), true);
});

test('processStartIdentity reads the Linux starttime and the ps lstart, and never throws', () => {
  const stat = '4242 (node (worker) x) S 1 4242 4242 0 -1 4194560 1 0 0 0 0 0 0 0 20 0 1 0 987654 1000 10';
  assert.equal(
    processStartIdentity(4242, 'linux', () => stat),
    'linux:987654',
  );
  assert.equal(
    processStartIdentity(4242, 'darwin', undefined, () => 'Mon Nov 16 09:00:00 2026\n'),
    'ps:Mon Nov 16 09:00:00 2026',
  );
  assert.equal(
    processStartIdentity(4242, 'darwin', undefined, () => ''),
    undefined,
  );
  const missing = () => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  };
  assert.equal(processStartIdentity(4242, 'linux', missing), undefined);
  assert.equal(processStartIdentity(4242, 'darwin', undefined, missing), undefined);
  assert.equal(processStartIdentity(4242, 'win32'), undefined);
  if (process.platform === 'linux' || process.platform === 'darwin') {
    const own = processStartIdentity(process.pid);
    assert.ok(own, 'the current process has a readable start identity');
    assert.equal(processStartIdentity(process.pid), own, 'the identity is stable');
  }
});

test('processExists reads ESRCH as gone and EPERM as present', () => {
  const failWith = (code: string) => () => {
    throw Object.assign(new Error(code), { code });
  };
  assert.equal(
    processExists(1, () => undefined),
    true,
  );
  assert.equal(processExists(1, failWith('ESRCH')), false);
  assert.equal(processExists(1, failWith('EPERM')), true);
  assert.equal(processExists(process.pid), true);
});
