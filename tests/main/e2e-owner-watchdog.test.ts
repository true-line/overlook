import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OWNER_PID_ENV,
  OWNER_POLL_MS,
  ownerGone,
  processExists,
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
  unrefCalls: () => number;
}

function harness(env: Record<string, string | undefined>, options: { packaged?: boolean; parent?: number } = {}): Harness {
  let parent = options.parent ?? 4242;
  let alive = true;
  let exitCount = 0;
  let unrefs = 0;
  let scheduled: (() => void) | undefined;
  const intervals: number[] = [];
  const deps: OwnerWatchdogDeps = {
    packaged: options.packaged ?? false,
    env,
    parentPid: () => parent,
    isAlive: () => alive,
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
  run.tick();
  assert.equal(run.exits(), 1);
});

test('the first launch is owned by its parent and records it for relaunched successors', () => {
  const env: Record<string, string | undefined> = { OVERLOOK_E2E: '1' };
  const watch = resolveOwnerWatch(harness(env).deps);
  assert.deepEqual(watch, { ownerPid: 4242, directChild: true });
  assert.equal(env[OWNER_PID_ENV], '4242');
});

test('an app.relaunch successor follows the original worker, not its dead predecessor', () => {
  const successor = harness({ OVERLOOK_E2E: '1', [OWNER_PID_ENV]: '4242' }, { parent: 9001 });
  const watch = startE2eOwnerWatchdog(successor.deps);
  assert.deepEqual(watch, { ownerPid: 4242, directChild: false });
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

test('a vanished owner is detected even without reparenting (Windows has none)', () => {
  const watch = { ownerPid: 4242, directChild: true };
  assert.equal(ownerGone(watch, { parentPid: () => 4242, isAlive: () => true }), false);
  assert.equal(ownerGone(watch, { parentPid: () => 4242, isAlive: () => false }), true);
  assert.equal(ownerGone(watch, { parentPid: () => 77, isAlive: () => true }), true);
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
