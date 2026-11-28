import { writeFileSync } from 'node:fs';
import type { Session } from 'node:inspector/promises';
import type { ElectronApplication } from '@playwright/test';

type ProfileState = typeof globalThis & { overlookPerfSession?: Session };

/** Opt-in diagnostic only: profiling perturbs timings, so these runs are not baselines. */
export async function profileMainProcess<T>(
  app: ElectronApplication,
  phase: 'startup' | 'query' | 'import',
  operation: () => Promise<T>,
): Promise<T> {
  if (process.env['OVERLOOK_PERF_PROFILE'] !== '1') return operation();
  console.log('[perf] DIAGNOSTIC CPU PROFILE ENABLED: timings are not baseline evidence');
  await app.evaluate(async () => {
    const { Session } = process.getBuiltinModule('node:inspector/promises');
    const session = new Session();
    session.connect();
    try {
      await session.post('Profiler.enable');
      await session.post('Profiler.start');
      (globalThis as ProfileState).overlookPerfSession = session;
    } catch (error) {
      session.disconnect();
      throw error;
    }
  });
  return captureDuringOperation(operation, async () => {
    const profile = await app.evaluate(async () => {
      const state = globalThis as ProfileState;
      const session = state.overlookPerfSession;
      if (session === undefined) throw new Error('missing main-process CPU profile session');
      try {
        return (await session.post('Profiler.stop')).profile;
      } finally {
        delete state.overlookPerfSession;
        session.disconnect();
      }
    });
    writeFileSync(`test-results/perf-${phase}-profile.cpuprofile`, JSON.stringify(profile));
  });
}

/** Retain diagnostic evidence even while the measured operation is still pending. */
export async function captureDuringOperation<T>(
  operation: () => Promise<T>,
  capture: () => Promise<void>,
  captureAfterMs = 30_000,
): Promise<T> {
  let captured: Promise<void> | undefined;
  const finish = (): Promise<void> => (captured ??= Promise.resolve().then(capture));
  const timer = setTimeout(() => {
    // The finally path reports capture failure. Attach a handler immediately so
    // an early capture rejection cannot become an unhandled rejection.
    void finish().catch(() => undefined);
  }, captureAfterMs);
  try {
    return await operation();
  } finally {
    clearTimeout(timer);
    await finish();
  }
}
