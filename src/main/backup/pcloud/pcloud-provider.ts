import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { once } from 'node:events';

import {
  assertSafeRemotePath,
  ProviderError,
  prepareProviderMutation,
  type ProviderAccountIdentity,
  type ProviderAuthState,
  type ProviderQuota,
  type RemoteEntry,
  type StorageProvider,
} from '../provider.js';
import { redactTokens } from './oauth.js';
import type { PCloudAuthRecord } from './token-store.js';

const DEFAULT_SPOOL_THRESHOLD_BYTES = 1024 * 1024;

interface PreparedUpload {
  readonly filename: string;
  readonly byteLength: number;
  readonly memoryPayload: Buffer | null;
  readonly spoolPath: string | null;
  cleanup(): Promise<void>;
}

function escapeMultipartValue(value: string): string {
  return value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"').replace(/\r/gu, '%0D').replace(/\n/gu, '%0A');
}

function encodeMultipartFraming(
  boundary: string,
  fields: readonly (readonly [string, string])[],
  filename: string,
): { readonly prefix: Buffer; readonly suffix: Buffer } {
  const parts: string[] = [];
  for (const [key, value] of fields) {
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${escapeMultipartValue(key)}"\r\n\r\n${value}\r\n`);
  }
  parts.push(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${escapeMultipartValue(filename)}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  );
  return {
    prefix: Buffer.from(parts.join(''), 'utf8'),
    suffix: Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
  };
}

function createMultipartBodyStream(prefix: Buffer, suffix: Buffer, upload: PreparedUpload): ReadableStream<Uint8Array> {
  if (upload.spoolPath === null) {
    const payload = upload.memoryPayload ?? Buffer.alloc(0);
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(prefix);
        if (payload.length > 0) controller.enqueue(payload);
        controller.enqueue(suffix);
        controller.close();
      },
    });
  }
  const spoolPath = upload.spoolPath;
  let reader: AsyncIterator<Buffer> | null = null;
  let fileStream: ReturnType<typeof createReadStream> | null = null;
  let phase: 'prefix' | 'file' | 'done' = 'prefix';
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(prefix);
      fileStream = createReadStream(spoolPath);
      reader = fileStream[Symbol.asyncIterator]();
      phase = 'file';
    },
    async pull(controller) {
      if (phase !== 'file' || reader === null) {
        controller.close();
        return;
      }
      const next = await reader.next();
      if (!next.done) {
        controller.enqueue(next.value);
        return;
      }
      fileStream?.destroy();
      fileStream = null;
      reader = null;
      phase = 'done';
      controller.enqueue(suffix);
      controller.close();
    },
    cancel() {
      fileStream?.destroy();
      fileStream = null;
      reader = null;
      phase = 'done';
    },
  });
}

async function prepareBoundedUpload(filename: string, bytes: Readable, spoolThresholdBytes: number): Promise<PreparedUpload> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let spoolPath: string | null = null;
  let writer: ReturnType<typeof createWriteStream> | null = null;
  try {
    for await (const raw of bytes) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
      totalBytes += chunk.length;
      if (writer === null && totalBytes <= spoolThresholdBytes) {
        chunks.push(chunk);
        continue;
      }
      if (writer === null) {
        spoolPath = join(tmpdir(), `overlook-pcloud-${randomUUID()}.part`);
        writer = createWriteStream(spoolPath, { mode: 0o600 });
        for (const prior of chunks) {
          if (!writer.write(prior)) await once(writer, 'drain');
        }
        chunks.length = 0;
      }
      if (!writer.write(chunk)) await once(writer, 'drain');
    }
    if (writer !== null) {
      writer.end();
      await once(writer, 'finish');
      writer = null;
    }
    const createdSpool = spoolPath;
    return {
      filename,
      byteLength: totalBytes,
      memoryPayload: createdSpool === null ? Buffer.concat(chunks, totalBytes) : null,
      spoolPath: createdSpool,
      cleanup: async () => {
        if (createdSpool !== null) await unlink(createdSpool).catch(() => undefined);
      },
    };
  } catch (error) {
    writer?.destroy();
    if (spoolPath !== null) await unlink(spoolPath).catch(() => undefined);
    throw error;
  }
}

// The live pCloud adapter (#255, ADR-0007): StorageProvider over pCloud's
// HTTP API, so the backup engine works against real pCloud exactly as
// against the mock. Blobs travel as-is (encrypt-once); everything lives
// under the adapter-owned /Overlook/<library-id>/ prefix; API usage follows
// the working image-trail integration (form-encoded POSTs, result-code
// envelope). The fetch implementation is injected so node:test covers every
// method and error mapping without network.

/** pCloud wraps errors in a JSON envelope: `result` 0 = ok, anything else
 * is a documented numeric code. The engine only understands ProviderError
 * kinds, so the interesting codes map here; unknown ones read as transient
 * (retry-then-surface beats misclassifying). */
function kindForResult(result: number): ProviderError['kind'] {
  if (result === 1000 || result === 2000 || result === 2003 || result === 2094 || result === 2095 || result === 4000) {
    // Log-in required / failed, access denied, invalid or expired token,
    // too many login tries — all mean "reconnect".
    return 'auth';
  }
  if (result === 2008) {
    return 'quota';
  }
  if (result === 2002 || result === 2005 || result === 2009) {
    // Parent directory / directory / file does not exist.
    return 'not-found';
  }
  return 'transient';
}

interface PCloudFileMeta {
  readonly name: string;
  readonly isfolder: boolean;
  readonly size?: number;
  readonly contents?: readonly PCloudFileMeta[];
}

export interface PCloudProviderOptions {
  /** Late-bound custody read — the token can appear (connect) or vanish
   * (disconnect) while the provider instance lives. */
  readonly auth: () => PCloudAuthRecord | null;
  /** Names this library's remote home: /Overlook/<libraryId>/… (ADR-0007). */
  readonly libraryId: string;
  /** Separate top-level roots prevent backup and interoperability enumeration. */
  readonly rootName?: string;
  /** Test seam; production uses global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Ciphertext streams larger than this spill to a 0o600 temp file instead of V8 heap. */
  readonly spoolThresholdBytes?: number;
}

export class PCloudProvider implements StorageProvider {
  readonly id = 'pcloud';
  readonly label = 'pCloud';
  readonly capabilities = {
    quota: 'known',
    verification: 'download-hash',
    resumableUpload: false,
    platforms: ['darwin', 'win32', 'linux'],
    interactiveAuth: true,
    reconnectRequired: true,
    accountIdentity: 'stable-subject',
  } as const;
  private readonly auth: () => PCloudAuthRecord | null;
  private readonly root: string;
  private readonly fetchImpl: typeof fetch;
  private readonly options: PCloudProviderOptions;
  private readonly spoolThresholdBytes: number;
  /** createfolderifnotexists is one round-trip per ancestor — remember what
   * exists so steady-state puts pay zero extra calls. */
  private readonly knownFolders = new Set<string>();

  constructor(options: PCloudProviderOptions) {
    this.options = options;
    this.auth = options.auth;
    const rootName = options.rootName ?? 'Overlook';
    if (!/^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/u.test(rootName)) throw new ProviderError('unsafe pCloud root name', 'corrupt');
    this.root = `/${rootName}/${options.libraryId}`;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.spoolThresholdBytes = options.spoolThresholdBytes ?? DEFAULT_SPOOL_THRESHOLD_BYTES;
  }

  async listLibraries(signal?: AbortSignal): Promise<readonly string[]> {
    let data: Record<string, unknown>;
    try {
      data = await this.api('listfolder', { path: this.root.slice(0, this.root.lastIndexOf('/')) }, undefined, signal);
    } catch (error) {
      if (error instanceof ProviderError && error.kind === 'not-found') return [];
      throw error;
    }
    const metadata = data['metadata'] as PCloudFileMeta | undefined;
    const candidates = (metadata?.contents ?? [])
      .filter((entry) => entry.isfolder && /^[A-Za-z0-9_-]{1,64}$/u.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    const libraries: string[] = [];
    for (const libraryId of candidates) {
      signal?.throwIfAborted();
      try {
        const root = this.root.slice(0, this.root.lastIndexOf('/'));
        const marker = await this.api('listfolder', { path: `${root}/${libraryId}/recovery` }, undefined, signal);
        const recovery = marker['metadata'] as PCloudFileMeta | undefined;
        if (recovery?.contents?.some((entry) => !entry.isfolder && entry.name === 'bootstrap.ovrb') === true) {
          libraries.push(libraryId);
        }
      } catch (error) {
        if (!(error instanceof ProviderError && error.kind === 'not-found')) throw error;
      }
    }
    return libraries;
  }

  forLibrary(libraryId: string): StorageProvider {
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(libraryId)) {
      throw new ProviderError(`unsafe library id: ${libraryId}`, 'corrupt');
    }
    return new PCloudProvider({ ...this.options, libraryId });
  }

  authState(): Promise<ProviderAuthState> {
    // Cheap truth: custody present. Expiry/revocation surfaces as kind=auth
    // errors on data calls (#256 wires that to the settings card).
    return Promise.resolve(this.auth() === null ? 'not-connected' : 'connected');
  }

  async accountIdentity(signal?: AbortSignal): Promise<ProviderAccountIdentity> {
    const data = await this.api('userinfo', {}, undefined, signal);
    const rawId = data['userid'];
    const accountId =
      typeof rawId === 'number' && Number.isSafeInteger(rawId) && rawId >= 0
        ? String(rawId)
        : typeof rawId === 'string' && /^\d+$/u.test(rawId)
          ? rawId
          : null;
    const accountLabel = typeof data['email'] === 'string' ? data['email'].trim() : '';
    if (accountId === null || accountLabel === '') {
      throw new ProviderError('pCloud account identity is unavailable', 'transient');
    }
    return { accountId, accountLabel };
  }

  private record(): PCloudAuthRecord {
    const record = this.auth();
    if (record === null) {
      throw new ProviderError('pCloud is not connected', 'auth', 'provider', true);
    }
    return record;
  }

  private async api(
    method: string,
    params: Record<string, string>,
    file?: PreparedUpload,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const record = this.record();
    let init: RequestInit & { duplex?: 'half' };
    if (file === undefined) {
      init = {
        method: 'POST',
        body: new URLSearchParams({ access_token: record.accessToken, ...params }),
        ...(signal === undefined ? {} : { signal }),
      };
    } else {
      // pCloud's upload protocol reads POST parameters that precede the file
      // part (Codex P1 on PR #259) — params first, file strictly last, with an
      // exact Content-Length over the bounded memory/temp-spool stream (#1438).
      const boundary = `----overlook-pcloud-${randomBytes(16).toString('hex')}`;
      const orderedFields: (readonly [string, string])[] = [['access_token', record.accessToken], ...Object.entries(params)];
      const { prefix, suffix } = encodeMultipartFraming(boundary, orderedFields, file.filename);
      const contentLength = prefix.length + file.byteLength + suffix.length;
      init = {
        method: 'POST',
        headers: {
          'content-type': `multipart/form-data; boundary=${boundary}`,
          'content-length': String(contentLength),
        },
        body: createMultipartBodyStream(prefix, suffix, file),
        duplex: 'half',
        ...(signal === undefined ? {} : { signal }),
      };
    }
    let response: Response;
    try {
      response = await this.fetchImpl(`https://${record.apiHost}/${method}`, init);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'network failure';
      throw new ProviderError(redactTokens(`pCloud ${method} failed: ${message}`), 'transient');
    }
    if (!response.ok) {
      throw new ProviderError(`pCloud ${method} answered HTTP ${String(response.status)}`, 'transient');
    }
    const data = (await response.json()) as Record<string, unknown>;
    const result = typeof data['result'] === 'number' ? data['result'] : Number.NaN;
    if (result !== 0) {
      const detail = typeof data['error'] === 'string' ? data['error'] : `result ${String(result)}`;
      throw new ProviderError(redactTokens(`pCloud ${method} failed: ${detail}`), kindForResult(result));
    }
    return data;
  }

  /** Remote absolute path for a provider-relative one, validated first. */
  private remotePath(path: string): string {
    assertSafeRemotePath(path);
    return `${this.root}/${path}`;
  }

  private async ensureFolder(remoteFolder: string): Promise<void> {
    if (this.knownFolders.has(remoteFolder)) {
      return;
    }
    // Ancestors first — createfolderifnotexists does not create parents.
    const segments = remoteFolder.split('/').filter((segment) => segment !== '');
    let current = '';
    for (const segment of segments) {
      current = `${current}/${segment}`;
      if (this.knownFolders.has(current)) {
        continue;
      }
      await this.api('createfolderifnotexists', { path: current });
      this.knownFolders.add(current);
    }
  }

  async put(path: string, bytes: Readable): Promise<{ bytes: number }> {
    const { folder, filename, upload } = await prepareProviderMutation(async () => {
      try {
        const remote = this.remotePath(path);
        const lastSlash = remote.lastIndexOf('/');
        const folder = remote.slice(0, lastSlash);
        const filename = remote.slice(lastSlash + 1);
        await this.ensureFolder(folder);
        const upload = await prepareBoundedUpload(filename, bytes, this.spoolThresholdBytes);
        return { folder, filename, upload };
      } catch (error) {
        bytes.destroy();
        throw error;
      }
    });
    try {
      // nopartial: pCloud must never publish a half-received file — the verify
      // step would then fail the whole batch instead of retrying one blob.
      const data = await this.api('uploadfile', { path: folder, filename, nopartial: '1' }, upload);
      const metadata = Array.isArray(data['metadata']) ? (data['metadata'] as PCloudFileMeta[]) : [];
      const size = metadata[0]?.size;
      if (typeof size !== 'number') {
        throw new ProviderError('pCloud uploadfile returned no file metadata', 'transient');
      }
      return { bytes: size };
    } finally {
      await upload.cleanup();
    }
  }

  async getStream(path: string): Promise<Readable> {
    const data = await this.api('getfilelink', { path: this.remotePath(path) });
    const hosts = Array.isArray(data['hosts']) ? (data['hosts'] as string[]) : [];
    const filePath = typeof data['path'] === 'string' ? data['path'] : null;
    if (hosts[0] === undefined || filePath === null) {
      throw new ProviderError('pCloud getfilelink returned no download host', 'transient');
    }
    let response: Response;
    try {
      response = await this.fetchImpl(`https://${hosts[0]}${filePath}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'network failure';
      throw new ProviderError(redactTokens(`pCloud download failed: ${message}`), 'transient');
    }
    if (!response.ok || response.body === null) {
      throw new ProviderError(`pCloud download answered HTTP ${String(response.status)}`, 'transient');
    }
    return Readable.fromWeb(response.body);
  }

  async probe(path: string, signal?: AbortSignal): Promise<{ bytes: number }> {
    const data = await this.api('checksumfile', { path: this.remotePath(path) }, undefined, signal);
    const metadata = data['metadata'] as PCloudFileMeta | undefined;
    if (typeof metadata?.size === 'number') return { bytes: metadata.size };
    throw new ProviderError(`pCloud checksumfile returned no size for ${path}`, 'transient');
  }

  async list(prefix: string, signal?: AbortSignal): Promise<readonly RemoteEntry[]> {
    let data: Record<string, unknown>;
    try {
      data = await this.api('listfolder', { path: this.remotePath(prefix), recursive: '1' }, undefined, signal);
    } catch (error) {
      if (error instanceof ProviderError && error.kind === 'not-found') {
        // A prefix nobody wrote to yet lists as empty, like the mock.
        return [];
      }
      throw error;
    }
    const entries: RemoteEntry[] = [];
    const walk = (nodes: readonly PCloudFileMeta[], parent: string): void => {
      for (const node of nodes) {
        signal?.throwIfAborted();
        if (node.isfolder) {
          walk(node.contents ?? [], `${parent}/${node.name}`);
        } else if (typeof node.size === 'number') {
          entries.push({ path: `${parent}/${node.name}`, bytes: node.size });
        }
      }
    };
    const metadata = data['metadata'] as PCloudFileMeta | undefined;
    walk(metadata?.contents ?? [], prefix);
    return entries;
  }

  async delete(path: string): Promise<void> {
    // Relied-upon recoverability contract (#750): pCloud's `deletefile` is
    // trash-backed server-side (60-day Trash) — it is the recoverable
    // deletion this product requires, and it is what made the #741 wipe
    // recoverable on pCloud. Any migration off `deletefile` must land on an
    // equally recoverable call, never a permanent purge.
    try {
      await this.api('deletefile', { path: this.remotePath(path) });
    } catch (error) {
      if (error instanceof ProviderError && error.kind === 'not-found') {
        // Idempotent like the mock's rm --force.
        return;
      }
      throw error;
    }
  }

  async quota(signal?: AbortSignal): Promise<ProviderQuota> {
    const data = await this.api('userinfo', {}, undefined, signal);
    const usedBytes = typeof data['usedquota'] === 'number' ? data['usedquota'] : 0;
    const totalBytes = typeof data['quota'] === 'number' ? data['quota'] : 0;
    return { usedBytes, totalBytes };
  }

  async verify(path: string): Promise<{ sha256: string; bytes: number }> {
    const data = await this.api('checksumfile', { path: this.remotePath(path) });
    const metadata = data['metadata'] as PCloudFileMeta | undefined;
    const bytes = typeof metadata?.size === 'number' ? metadata.size : null;
    const sha256 = typeof data['sha256'] === 'string' ? data['sha256'] : null;
    if (sha256 !== null && bytes !== null) {
      return { sha256, bytes };
    }
    // US region reports sha1/md5 only — re-download and hash per the
    // interface contract (never skip verification).
    const stream = await this.getStream(path);
    const hash = createHash('sha256');
    let counted = 0;
    for await (const chunk of stream) {
      const piece = chunk as Buffer;
      hash.update(piece);
      counted += piece.length;
    }
    return { sha256: hash.digest('hex'), bytes: counted };
  }
}
