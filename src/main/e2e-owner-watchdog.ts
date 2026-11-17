/**
 * E2E owner watchdog: an unpackaged harness launch exits when the Playwright
 * worker that launched it is gone.
 *
 * Playwright starts every Electron app in its own process group and drives it
 * over a debugging socket, so nothing ties the app's lifetime to the worker.
 * When a run is hard-killed (an agent's command timeout, the OOM killer, a
 * memory guard's SIGKILL of its process group, a double Ctrl-C) the worker
 * dies without closing its apps: each live instance — main, zygotes, GPU,
 * renderer and network processes, ~1 GB RSS — is reparented to init and keeps
 * running forever, outside the killed group and outside any process tree a
 * guard can walk. Repeated killed runs stack those orphans until the machine
 * runs out of memory. The watchdog makes the app follow its owner down.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export const OWNER_PID_ENV = 'OVERLOOK_E2E_OWNER_PID';
export const OWNER_START_ENV = 'OVERLOOK_E2E_OWNER_START';
export const OWNER_POLL_MS = 1_000;

export interface OwnerWatchdogDeps {
  readonly packaged: boolean;
  readonly env: Record<string, string | undefined>;
  /** Live parent pid (Node's `process.ppid` re-reads it on every access). */
  readonly parentPid: () => number;
  /** True while a process with this pid exists. */
  readonly isAlive: (pid: number) => boolean;
  /** Start-time identity of a live pid, or undefined when it can't be read here. */
  readonly startIdentity: (pid: number) => string | undefined;
  /** Leave immediately; called at most once. */
  readonly exit: () => void;
  readonly schedule: (tick: () => void, intervalMs: number) => { unref?: () => void };
}

export interface OwnerWatch {
  readonly ownerPid: number;
  /** True when the owner is this process's original parent, so reparenting alone proves it is gone. */
  readonly directChild: boolean;
  /** The owner's start-time identity, so a reused pid is not mistaken for it. */
  readonly ownerStart?: string;
}

/**
 * Decide which process owns this launch. The first harness launch is owned by
 * its parent (the Playwright worker) and records that pid in the environment,
 * so an `app.relaunch()` successor — whose parent is the instance that just
 * exited — keeps following the same worker instead of the dead predecessor.
 * A first launch that is already parented to init lost its worker while it
 * was still starting (the kill landed mid-launch); its owner is gone from the
 * first tick. The owner's start time is recorded with its pid, so a
 * successor that outlives the worker can't latch onto a process that later
 * reuses the pid.
 */
export function resolveOwnerWatch(deps: Pick<OwnerWatchdogDeps, 'packaged' | 'env' | 'parentPid' | 'startIdentity'>): OwnerWatch | null {
  if (deps.packaged || deps.env['OVERLOOK_E2E'] !== '1') return null;
  const parent = deps.parentPid();
  const inherited = Number(deps.env[OWNER_PID_ENV]);
  if (Number.isSafeInteger(inherited) && inherited > 1) {
    const ownerStart = deps.env[OWNER_START_ENV] || undefined;
    return { ownerPid: inherited, directChild: inherited === parent, ...(ownerStart ? { ownerStart } : {}) };
  }
  if (!Number.isSafeInteger(parent)) return null;
  if (parent <= 1) return { ownerPid: parent, directChild: true };
  deps.env[OWNER_PID_ENV] = String(parent);
  const ownerStart = deps.startIdentity(parent);
  if (ownerStart) deps.env[OWNER_START_ENV] = ownerStart;
  return { ownerPid: parent, directChild: true, ...(ownerStart ? { ownerStart } : {}) };
}

export function ownerGone(watch: OwnerWatch, deps: Pick<OwnerWatchdogDeps, 'parentPid' | 'isAlive' | 'startIdentity'>): boolean {
  if (watch.ownerPid <= 1) return true;
  if (watch.directChild) {
    // On POSIX the live parent pid is exact: once the owner dies this process is reparented,
    // and a later process reusing the owner's pid can never become its parent.
    if (deps.parentPid() !== watch.ownerPid) return true;
  } else if (watch.ownerStart !== undefined) {
    // A successor isn't the owner's child, so only the start time tells the owner from a reused pid.
    // An unreadable start (gone, or a transient `ps` failure) falls through to the liveness probe.
    const current = deps.startIdentity(watch.ownerPid);
    if (current !== undefined && current !== watch.ownerStart) return true;
  }
  return !deps.isAlive(watch.ownerPid);
}

/** Start the watchdog for an unpackaged E2E launch; a no-op everywhere else. */
export function startE2eOwnerWatchdog(deps: OwnerWatchdogDeps): OwnerWatch | null {
  const watch = resolveOwnerWatch(deps);
  if (watch === null) return null;
  let fired = false;
  const timer = deps.schedule(() => {
    if (fired || !ownerGone(watch, deps)) return;
    fired = true;
    deps.exit();
  }, OWNER_POLL_MS);
  // Never keep an otherwise-finished process alive just to poll.
  timer.unref?.();
  return watch;
}

/** `kill(pid, 0)` probe: ESRCH means gone; EPERM still means the pid exists. */
export function processExists(
  pid: number,
  kill: (pid: number, signal: 0) => void = (target, signal) => process.kill(target, signal),
): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Start-time identity of a pid: `/proc/<pid>/stat` starttime on Linux, `ps -o lstart` on macOS
 * and the BSDs. Undefined when the process is gone or the platform has no cheap source (Windows).
 */
export function processStartIdentity(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  readStat: (path: string) => string = (path) => readFileSync(path, 'utf8'),
  runPs: (pid: number) => string = (target) =>
    execFileSync('ps', ['-o', 'lstart=', '-p', String(target)], { encoding: 'utf8', timeout: 2_000 }),
): string | undefined {
  try {
    if (platform === 'linux') {
      const stat = readStat(`/proc/${pid}/stat`);
      // Field 22 (starttime); the comm field can contain spaces and parentheses, so split after the last ')'.
      const starttime = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
      return starttime && /^\d+$/.test(starttime) ? `linux:${starttime}` : undefined;
    }
    if (platform === 'darwin' || platform === 'freebsd' || platform === 'openbsd') {
      const lstart = runPs(pid).trim();
      return lstart ? `ps:${lstart}` : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}
