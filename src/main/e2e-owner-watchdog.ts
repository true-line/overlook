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

export const OWNER_PID_ENV = 'OVERLOOK_E2E_OWNER_PID';
export const OWNER_POLL_MS = 1_000;

export interface OwnerWatchdogDeps {
  readonly packaged: boolean;
  readonly env: Record<string, string | undefined>;
  /** Live parent pid (Node's `process.ppid` re-reads it on every access). */
  readonly parentPid: () => number;
  /** True while a process with this pid exists. */
  readonly isAlive: (pid: number) => boolean;
  /** Leave immediately; called at most once. */
  readonly exit: () => void;
  readonly schedule: (tick: () => void, intervalMs: number) => { unref?: () => void };
}

export interface OwnerWatch {
  readonly ownerPid: number;
  /** True when the owner is this process's original parent, so reparenting alone proves it is gone. */
  readonly directChild: boolean;
}

/**
 * Decide which process owns this launch. The first harness launch is owned by
 * its parent (the Playwright worker) and records that pid in the environment,
 * so an `app.relaunch()` successor — whose parent is the instance that just
 * exited — keeps following the same worker instead of the dead predecessor.
 * A first launch that is already parented to init lost its worker while it
 * was still starting (the kill landed mid-launch); its owner is gone from the
 * first tick.
 */
export function resolveOwnerWatch(deps: Pick<OwnerWatchdogDeps, 'packaged' | 'env' | 'parentPid'>): OwnerWatch | null {
  if (deps.packaged || deps.env['OVERLOOK_E2E'] !== '1') return null;
  const parent = deps.parentPid();
  const inherited = Number(deps.env[OWNER_PID_ENV]);
  if (Number.isSafeInteger(inherited) && inherited > 1) return { ownerPid: inherited, directChild: inherited === parent };
  if (!Number.isSafeInteger(parent)) return null;
  if (parent > 1) deps.env[OWNER_PID_ENV] = String(parent);
  return { ownerPid: parent, directChild: true };
}

export function ownerGone(watch: OwnerWatch, deps: Pick<OwnerWatchdogDeps, 'parentPid' | 'isAlive'>): boolean {
  if (watch.ownerPid <= 1) return true;
  if (watch.directChild && deps.parentPid() !== watch.ownerPid) return true;
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
