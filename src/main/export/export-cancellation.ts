import { rm } from 'node:fs/promises';
import type { Readable } from 'node:stream';

export function exportAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

export class ExportCancelledError extends Error {
  override readonly name = 'AbortError';
  constructor() {
    super('Export cancelled');
  }
}

/** A cancelled caller stops waiting, not observing. Native/OS work remains
 * owned until it actually settles; its late values cannot resume the export. */
export class ExportFileWork {
  private readonly pending = new Set<Promise<void>>();
  private readonly streams = new Set<Readable>();
  private readonly outputs = new Set<string>();
  private readonly abort = () => this.stopStreams();

  constructor(
    readonly signal: AbortSignal | undefined,
    private readonly report: (error: unknown) => void,
    private readonly remove: (path: string) => Promise<void> = (path) => rm(path, { force: true }),
  ) {
    signal?.addEventListener('abort', this.abort, { once: true });
  }

  check(): void {
    if (this.signal?.aborted === true) throw new ExportCancelledError();
  }

  own(stream: Readable): Readable {
    this.streams.add(stream);
    if (this.signal?.aborted === true) stream.destroy();
    this.check();
    return stream;
  }

  wait<T>(start: () => Promise<T>, disposeLate?: (value: T) => Promise<void> | void): Promise<T> {
    this.check();
    return new Promise<T>((resolve, reject) => {
      let abandoned = false;
      const abort = () => {
        abandoned = true;
        reject(new ExportCancelledError());
      };
      this.signal?.addEventListener('abort', abort, { once: true });
      let operation: Promise<T>;
      try {
        operation = start();
      } catch (error) {
        this.signal?.removeEventListener('abort', abort);
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      const observed = operation
        .then(
          async (value) => {
            this.signal?.removeEventListener('abort', abort);
            if (abandoned) await disposeLate?.(value);
            else resolve(value);
          },
          (error: unknown) => {
            this.signal?.removeEventListener('abort', abort);
            if (!abandoned) reject(error instanceof Error ? error : new Error(String(error)));
            else if (!(error instanceof Error && error.name === 'AbortError')) this.report(error);
          },
        )
        .catch((error: unknown) => this.report(error));
      this.pending.add(observed);
      void observed.then(() => this.pending.delete(observed));
    });
  }

  async write(
    path: string,
    plaintext: Readable,
    writer: (path: string, stream: Readable, signal?: AbortSignal) => Promise<void>,
  ): Promise<void> {
    this.own(plaintext);
    await this.wait(
      () => writer(path, plaintext, this.signal),
      () => this.remove(path),
    );
    this.outputs.add(path);
  }

  /** Snapshot before awaiting: a caller may separately race this retirement
   * against abort without making retirement wait on itself. */
  async retire(completed: boolean, release?: () => Promise<void>): Promise<void> {
    const pending = [...this.pending];
    this.signal?.removeEventListener('abort', this.abort);
    this.stopStreams();
    if (!completed) {
      for (const path of this.outputs) await this.cleanup(() => this.remove(path));
    }
    await Promise.all(pending);
    if (release !== undefined) await this.cleanup(release);
  }

  private stopStreams(): void {
    for (const stream of this.streams) {
      try {
        stream.destroy();
      } catch (error) {
        this.report(error);
      }
    }
  }

  private async cleanup(operation: () => Promise<void>): Promise<void> {
    try {
      await operation();
    } catch (error) {
      this.report(error);
    }
  }
}
