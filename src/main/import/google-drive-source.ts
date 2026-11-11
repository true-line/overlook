import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { buildGoogleDriveAuthorizeUrl, createPkce, exchangeGoogleDriveCode } from '../backup/google-drive/oauth.js';
import { startGoogleDriveLoopbackCapture } from '../backup/google-drive/loopback.js';
import { classifyMediaFile } from '../../shared/library/media-files.js';
import { sanitizeImportedFileName } from '../export/export-path-safety.js';
import { collectMediaCandidates, type ImportCandidate } from './source-scanner.js';

const DRIVE_API = 'https://www.googleapis.com/drive/v3/files';

export type GoogleDrivePickFailure =
  'cancelled' | 'unavailable' | 'busy' | 'authorization-failed' | 'no-supported-files' | 'download-failed';

export interface GoogleDriveStagedSelection {
  readonly id: string;
  /** Null only for the unpackaged E2E fixture, which must never be removed. */
  readonly rootPath: string | null;
  readonly files: readonly ImportCandidate[];
  readonly skipped: number;
}

export type GoogleDriveSourcePickResult =
  { readonly status: 'ready'; readonly selection: GoogleDriveStagedSelection } | { readonly status: GoogleDrivePickFailure };

interface DriveFileMetadata {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly mimeType?: unknown;
  readonly trashed?: unknown;
  readonly capabilities?: unknown;
}

export interface GoogleDriveImportSourceOptions {
  readonly stagingRoot: string;
  readonly clientId: () => string | null;
  readonly clientSecret?: (() => string | null) | undefined;
  readonly openExternal: (url: string) => Promise<void>;
  readonly fixtureSource?: (() => string | undefined) | undefined;
  readonly fetchImpl?: typeof fetch;
  readonly capture?: typeof startGoogleDriveLoopbackCapture;
}

/** User-selected Drive files only. Picker authorization is deliberately
 * ephemeral: it cannot switch or widen the configured backup account. */
export class GoogleDriveImportSource {
  private readonly stagingRoot: string;
  private picking = false;
  private pickController: AbortController | null = null;

  constructor(private readonly options: GoogleDriveImportSourceOptions) {
    this.stagingRoot = resolve(options.stagingRoot);
  }

  async pick(): Promise<GoogleDriveSourcePickResult> {
    if (this.picking) return { status: 'busy' };
    this.picking = true;
    const controller = new AbortController();
    this.pickController = controller;
    try {
      return await this.pickOnce(controller.signal);
    } finally {
      if (this.pickController === controller) this.pickController = null;
      this.picking = false;
    }
  }

  cancelPick(): void {
    this.pickController?.abort();
  }

  private async pickOnce(signal: AbortSignal): Promise<GoogleDriveSourcePickResult> {
    const fixture = this.options.fixtureSource?.();
    if (fixture !== undefined && fixture !== '') {
      const files = await collectMediaCandidates([fixture]);
      if (signal.aborted) return { status: 'cancelled' };
      return files.length === 0
        ? { status: 'no-supported-files' }
        : { status: 'ready', selection: { id: randomUUID(), rootPath: null, files, skipped: 0 } };
    }

    const clientId = this.options.clientId();
    if (clientId === null) return { status: 'unavailable' };
    const state = randomUUID().replaceAll('-', '');
    const pkce = createPkce();
    const capture = (this.options.capture ?? startGoogleDriveLoopbackCapture)({
      state,
      requirePickedFiles: true,
    });
    const cancelCapture = (): void => capture.close();
    signal.addEventListener('abort', cancelCapture, { once: true });

    try {
      const { redirectUri } = await capture.listening;
      signal.throwIfAborted();
      await this.options.openExternal(
        buildGoogleDriveAuthorizeUrl({ clientId, redirectUri, state, challenge: pkce.challenge, picker: true }),
      );
      const callback = await capture.result;
      const tokens = await exchangeGoogleDriveCode({
        clientId,
        clientSecret: this.options.clientSecret?.() ?? null,
        code: callback.code,
        verifier: pkce.verifier,
        redirectUri,
        requireRefreshToken: false,
        fetchImpl: this.fetchWithSignal(signal),
      });
      return await this.stage(callback.pickedFileIds, tokens.accessToken, signal);
    } catch (error) {
      if (signal.aborted) return { status: 'cancelled' };
      const message = error instanceof Error ? error.message : '';
      return /access_denied|cancelled|returned no files/iu.test(message) ? { status: 'cancelled' } : { status: 'authorization-failed' };
    } finally {
      signal.removeEventListener('abort', cancelCapture);
      capture.close();
    }
  }

  async discard(selection: GoogleDriveStagedSelection): Promise<void> {
    if (selection.rootPath !== null) await this.cleanupRoot(selection.rootPath);
  }

  async cleanupRoot(rootPath: string): Promise<void> {
    if (!this.isOwnedRoot(rootPath)) return;
    await rm(resolve(rootPath), { recursive: true, force: true });
  }

  /** Startup removes abandoned selections but preserves the journal-owned
   * directory needed to resume an interrupted cloud import. */
  async cleanupOrphans(preserveRoot: string | null): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(this.stagingRoot, { withFileTypes: true });
    } catch {
      return;
    }
    const preserved = preserveRoot === null ? null : resolve(preserveRoot);
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && entry.name.startsWith('selection-'))
        .map(async (entry) => {
          const candidate = join(this.stagingRoot, entry.name);
          if (candidate !== preserved) await this.cleanupRoot(candidate);
        }),
    );
  }

  private async stage(fileIds: readonly string[], accessToken: string, signal: AbortSignal): Promise<GoogleDriveSourcePickResult> {
    await mkdir(this.stagingRoot, { recursive: true, mode: 0o700 });
    const rootPath = await mkdtemp(join(this.stagingRoot, 'selection-'));
    const files: ImportCandidate[] = [];
    let skipped = 0;
    let downloadFailures = 0;

    try {
      for (const [index, fileId] of fileIds.entries()) {
        signal.throwIfAborted();
        try {
          const metadata = await this.metadata(fileId, accessToken, signal);
          const fileName = this.downloadableName(metadata, fileId);
          const kind = fileName === null ? null : classifyMediaFile(fileName);
          if (fileName === null || kind === null) {
            skipped += 1;
            continue;
          }
          const response = await this.authorizedFetch(
            `${DRIVE_API}/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`,
            accessToken,
            signal,
          );
          if (!response.ok) throw new Error(`download failed: HTTP ${String(response.status)}`);
          const path = join(rootPath, `${String(index).padStart(4, '0')}-${randomUUID()}`);
          await writeFile(path, Buffer.from(await response.arrayBuffer()), { flag: 'wx', mode: 0o600 });
          signal.throwIfAborted();
          files.push({ path, fileName, kind });
        } catch {
          if (signal.aborted) throw new Error('Google Drive selection cancelled');
          skipped += 1;
          downloadFailures += 1;
        }
      }

      if (files.length === 0) {
        await this.cleanupRoot(rootPath);
        return { status: downloadFailures > 0 ? 'download-failed' : 'no-supported-files' };
      }
      return { status: 'ready', selection: { id: randomUUID(), rootPath, files, skipped } };
    } catch (error) {
      await this.cleanupRoot(rootPath);
      throw error;
    }
  }

  private async metadata(fileId: string, accessToken: string, signal: AbortSignal): Promise<DriveFileMetadata> {
    const fields = 'id,name,mimeType,trashed,capabilities(canDownload)';
    const response = await this.authorizedFetch(
      `${DRIVE_API}/${encodeURIComponent(fileId)}?fields=${encodeURIComponent(fields)}&supportsAllDrives=true`,
      accessToken,
      signal,
    );
    if (!response.ok) throw new Error(`metadata failed: HTTP ${String(response.status)}`);
    return (await response.json()) as DriveFileMetadata;
  }

  private downloadableName(metadata: DriveFileMetadata, expectedId: string): string | null {
    if (metadata.id !== expectedId || typeof metadata.name !== 'string' || metadata.name === '') return null;
    if (metadata.trashed === true || metadata.mimeType === 'application/vnd.google-apps.folder') return null;
    if (typeof metadata.capabilities === 'object' && metadata.capabilities !== null) {
      const capabilities = metadata.capabilities as { readonly canDownload?: unknown };
      if (capabilities.canDownload === false) return null;
    }
    return sanitizeImportedFileName(metadata.name);
  }

  private authorizedFetch(url: string, accessToken: string, signal: AbortSignal): Promise<Response> {
    return (this.options.fetchImpl ?? fetch)(url, { headers: { authorization: `Bearer ${accessToken}` }, signal });
  }

  private fetchWithSignal(signal: AbortSignal): typeof fetch {
    return (input, init) => (this.options.fetchImpl ?? fetch)(input, { ...init, signal });
  }

  private isOwnedRoot(rootPath: string): boolean {
    const candidate = resolve(rootPath);
    return dirname(candidate) === this.stagingRoot && basename(candidate).startsWith('selection-');
  }
}
