import { LocalCustodyRepository } from '../db/local-custody-repository.js';
import type { LibraryParts } from '../library/library-parts.js';
import { BackupIntegrityCursorStore } from './integrity-cursor.js';
import { LocalCustodyScrubber, type LocalCustodySummary } from './local-custody-scrubber.js';

export const LOCAL_CUSTODY_PASS_INTERVAL_MS = 60_000;

export interface LocalCustodyRuntime {
  readonly scrub: () => Promise<LocalCustodySummary | undefined>;
  readonly close: () => Promise<void>;
}

/** Provider-independent, single-flight maintenance. Closing revokes stream
 * access first and drains before the library releases its database and keys. */
export function createLocalCustodyRuntime(
  parts: {
    readonly db: LibraryParts['db'];
    readonly blobStore: Pick<LibraryParts['blobStore'], 'inspectOriginal' | 'getEncryptedStream'>;
    readonly blobStoreReady: Promise<void>;
    readonly keyStore: Pick<LibraryParts['keyStore'], 'resolver'>;
  },
  changed: (photoIds: readonly string[]) => void,
  audit: (line: string) => void,
): LocalCustodyRuntime {
  const controller = new AbortController();
  const scrubber = new LocalCustodyScrubber({
    repo: new LocalCustodyRepository(parts.db),
    inspect: (hash) => parts.blobStore.inspectOriginal(hash),
    encryptedStream: (hash) => parts.blobStore.getEncryptedStream(hash),
    resolveKey: parts.keyStore.resolver(),
    cursor: new BackupIntegrityCursorStore(parts.db, 'local-custody'),
    changed,
    audit,
    now: () => new Date(),
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let current: Promise<LocalCustodySummary | undefined> | undefined;
  const scrub = (): Promise<LocalCustodySummary | undefined> => {
    if (controller.signal.aborted) return Promise.resolve(undefined);
    current ??= parts.blobStoreReady
      .then(async () => {
        if (controller.signal.aborted) return undefined;
        return scrubber.scrub(controller.signal);
      })
      .finally(() => {
        current = undefined;
      });
    return current;
  };
  const schedule = (delay: number): void => {
    if (controller.signal.aborted) return;
    timer = setTimeout(() => {
      timer = undefined;
      void scrub()
        .catch(() => {
          if (!controller.signal.aborted) audit('INTEGRITY-LOCAL-DEFERRED reason=pass-unavailable');
        })
        .finally(() => schedule(LOCAL_CUSTODY_PASS_INTERVAL_MS));
    }, delay);
    timer.unref();
  };
  schedule(0);
  return {
    scrub,
    close: async () => {
      controller.abort();
      clearTimeout(timer);
      await current?.catch(() => undefined);
    },
  };
}
