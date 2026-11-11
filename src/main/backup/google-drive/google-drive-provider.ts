import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { Readable } from 'node:stream';

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
import type { GoogleDriveAuthClient } from './auth-client.js';
import {
  GOOGLE_DRIVE_DISCOVERY_PROTOCOL,
  googleDriveDiscoveryHash,
  googleDriveFileIdentity,
  googleDriveFolderIdentity,
  googleDriveLibraryIdentity,
  googleDriveRootIdentity,
} from './discovery-protocol.js';
import type { GoogleDrivePathStore } from './path-store.js';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const BINARY_MIME = 'application/octet-stream';
const BACKUP_OWNER = 'qwts-photos';
const DRIVE_CHUNK_QUANTUM = 256 * 1024;
const CHUNK_BYTES = 8 * 1024 * 1024;
const FILE_FIELDS = 'id,name,mimeType,size,sha256Checksum,appProperties,trashed';

interface DriveFile {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly mimeType?: unknown;
  readonly size?: unknown;
  readonly sha256Checksum?: unknown;
  readonly appProperties?: unknown;
  readonly trashed?: unknown;
}

interface DriveFileList {
  readonly files?: unknown;
  readonly nextPageToken?: unknown;
}

export interface GoogleDriveProviderOptions {
  readonly auth: GoogleDriveAuthClient;
  readonly paths: GoogleDrivePathStore;
  readonly libraryId: string;
  readonly rootName?: string;
  readonly owner?: string;
  readonly fetchImpl?: typeof fetch;
  /** Resumable upload chunk size; must be a positive multiple of 256 KiB. */
  readonly chunkBytes?: number;
}

function quoteQuery(value: string): string {
  return value.replace(/\\/gu, '\\\\').replace(/'/gu, "\\'");
}

function idOf(file: DriveFile): string | null {
  return typeof file.id === 'string' && file.id !== '' ? file.id : null;
}

function bytesOf(value: unknown): number | null {
  const number = typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : typeof value === 'number' ? value : Number.NaN;
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function isFolder(file: DriveFile): boolean {
  return file.mimeType === FOLDER_MIME && file.trashed !== true;
}

function rangeOffset(value: string | null): number {
  if (value === null) return 0;
  const match = /^bytes=0-(\d+)$/u.exec(value);
  if (match?.[1] === undefined) throw new ProviderError('Google Drive returned an invalid resumable upload range', 'transient');
  return Number(match[1]) + 1;
}

function providerKind(status: number, reason: string | null): ProviderError['kind'] {
  if (status === 401) return 'auth';
  if (status === 404) return 'not-found';
  if (status === 429 || status === 408 || status >= 500 || reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded') {
    return 'transient';
  }
  if (status === 403 && (reason === 'storageQuotaExceeded' || reason === 'quotaExceeded')) return 'quota';
  if (status === 403) return 'auth';
  if (status === 400) return 'corrupt';
  return 'transient';
}

/** Drive v3 adapter for the app-owned Overlook tree. Remote paths remain
 * provider-relative; only already-encrypted envelope bytes cross this seam. */
export class GoogleDriveProvider implements StorageProvider {
  readonly id = 'google-drive';
  readonly label = 'Google Drive';
  readonly capabilities = {
    quota: 'known',
    verification: 'server-checksum',
    resumableUpload: true,
    platforms: ['darwin', 'win32', 'linux'],
    interactiveAuth: true,
    reconnectRequired: true,
    accountIdentity: 'stable-subject',
  } as const;

  private readonly fetchImpl: typeof fetch;
  private readonly rootName: string;
  private readonly owner: string;
  private readonly chunkBytes: number;

  constructor(
    private readonly options: GoogleDriveProviderOptions,
    private readonly validatedIds = new Set<string>(),
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.rootName = options.rootName ?? 'Overlook';
    this.owner = options.owner ?? BACKUP_OWNER;
    this.chunkBytes = options.chunkBytes ?? CHUNK_BYTES;
    if (!/^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/u.test(this.rootName) || !/^[a-z0-9-]{3,64}$/u.test(this.owner)) {
      throw new ProviderError('unsafe Google Drive namespace identity', 'corrupt');
    }
    if (!Number.isSafeInteger(this.chunkBytes) || this.chunkBytes <= 0 || this.chunkBytes % DRIVE_CHUNK_QUANTUM !== 0) {
      throw new ProviderError('Google Drive upload chunk size must be a positive multiple of 256 KiB', 'corrupt');
    }
  }

  authState(): Promise<ProviderAuthState> {
    return Promise.resolve(this.options.auth.authState());
  }

  async accountIdentity(signal?: AbortSignal): Promise<ProviderAccountIdentity> {
    const url = new URL(`${API}/about`);
    url.searchParams.set('fields', 'user(permissionId,emailAddress)');
    const data = await this.json(url.toString(), undefined, 'read account identity', signal);
    const user = typeof data['user'] === 'object' && data['user'] !== null ? (data['user'] as Record<string, unknown>) : {};
    const accountId = typeof user['permissionId'] === 'string' ? user['permissionId'].trim() : '';
    const accountLabel = typeof user['emailAddress'] === 'string' ? user['emailAddress'].trim() : '';
    if (accountId === '' || accountLabel === '') {
      throw new ProviderError('Google Drive account identity is unavailable', 'transient');
    }
    return { accountId, accountLabel };
  }

  forLibrary(libraryId: string): StorageProvider {
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(libraryId)) {
      throw new ProviderError(`unsafe library id: ${libraryId}`, 'corrupt');
    }
    return new GoogleDriveProvider({ ...this.options, libraryId }, this.validatedIds);
  }

  /** Folder/file IDs are account-scoped. OAuth replacement must invalidate
   * both the durable path index and this process's validation memo before any
   * request can target the newly selected account. */
  resetAccountCache(): void {
    this.validatedIds.clear();
    this.options.paths.clear();
  }

  async listLibraries(signal?: AbortSignal): Promise<readonly string[]> {
    const root = await this.resolveOverlookFolder(false, signal);
    if (root === null) return [];
    const children = await this.listChildren(root, signal);
    const candidates = children
      .filter((entry) => isFolder(entry) && typeof entry.name === 'string' && /^[A-Za-z0-9_-]{1,64}$/u.test(entry.name))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    const libraries: string[] = [];
    for (const candidate of candidates) {
      signal?.throwIfAborted();
      const libraryId = candidate.name as string;
      const candidateId = idOf(candidate);
      if (candidateId === null) continue;
      this.options.paths.setFolderId(this.pathLibraryId(libraryId), '', candidateId);
      const scoped = this.forLibrary(libraryId) as GoogleDriveProvider;
      if ((await scoped.resolveFile('recovery/bootstrap.ovrb', false, signal)) !== null) libraries.push(libraryId);
    }
    return libraries;
  }

  async put(path: string, bytes: Readable): Promise<{ bytes: number }> {
    const { existing, session } = await prepareProviderMutation(async () => {
      try {
        assertSafeRemotePath(path);
        const existing = await this.resolveFile(path);
        const parentPath = posix.dirname(path) === '.' ? '' : posix.dirname(path);
        const parentId = await this.resolveFolder(parentPath, true);
        if (parentId === null) throw new ProviderError('Google Drive could not create the destination folder', 'transient');
        const name = posix.basename(path);
        const metadata = {
          name,
          mimeType: BINARY_MIME,
          appProperties: this.properties(googleDriveFileIdentity(this.options.libraryId, path)),
          ...(existing === null ? { parents: [parentId] } : {}),
        };
        const endpoint =
          existing === null
            ? `${UPLOAD_API}/files?uploadType=resumable&fields=${encodeURIComponent(FILE_FIELDS)}`
            : `${UPLOAD_API}/files/${encodeURIComponent(existing.id)}?uploadType=resumable&fields=${encodeURIComponent(FILE_FIELDS)}`;
        const initiated = await this.authorizedFetch(endpoint, {
          method: existing === null ? 'POST' : 'PATCH',
          headers: {
            'content-type': 'application/json; charset=UTF-8',
            'x-upload-content-type': BINARY_MIME,
          },
          body: JSON.stringify(metadata),
        });
        if (!initiated.ok) throw await this.responseError(initiated, 'start resumable upload');
        const location = initiated.headers.get('location');
        if (location === null) throw new ProviderError('Google Drive returned no resumable upload location', 'transient');
        const session = new URL(location);
        if (session.protocol !== 'https:' || session.hostname !== 'www.googleapis.com') {
          throw new ProviderError('Google Drive returned an unsafe resumable upload location', 'corrupt');
        }
        return { existing, session };
      } catch (error) {
        bytes.destroy();
        throw error;
      }
    });
    const uploaded = await this.uploadSession(session.toString(), bytes);
    const id = idOf(uploaded) ?? existing?.id ?? null;
    const recordedBytes = bytesOf(uploaded.size);
    if (id === null || recordedBytes === null) {
      throw new ProviderError('Google Drive upload returned incomplete file metadata', 'transient');
    }
    this.options.paths.setFileId(this.pathLibraryId(), path, id);
    this.validatedIds.add(id);
    return { bytes: recordedBytes };
  }

  async getStream(path: string): Promise<Readable> {
    assertSafeRemotePath(path);
    const file = await this.resolveFile(path);
    if (file === null) throw new ProviderError(`no Google Drive entry at ${path}`, 'not-found');
    const response = await this.authorizedFetch(`${API}/files/${encodeURIComponent(file.id)}?alt=media`);
    if (!response.ok) throw await this.responseError(response, 'download');
    if (response.body === null) throw new ProviderError('Google Drive download returned no body', 'transient');
    return Readable.fromWeb(response.body);
  }

  async probe(path: string, signal?: AbortSignal): Promise<{ bytes: number }> {
    const file = await this.resolveFile(path, true, signal);
    if (file === null) throw new ProviderError(`no Google Drive entry at ${path}`, 'not-found');
    const bytes = bytesOf(file.metadata.size);
    if (bytes === null) throw new ProviderError(`Google Drive entry at ${path} has no size`, 'transient');
    return { bytes };
  }

  async list(prefix: string, signal?: AbortSignal): Promise<readonly RemoteEntry[]> {
    if (prefix !== '.') assertSafeRemotePath(prefix);
    const normalized = prefix === '.' ? '' : prefix;
    const folderId = await this.resolveFolder(normalized, false, signal);
    if (folderId === null) return [];
    const entries: RemoteEntry[] = [];
    await this.walk(folderId, normalized, entries, signal);
    return entries.sort((a, b) => a.path.localeCompare(b.path));
  }

  async delete(path: string): Promise<void> {
    assertSafeRemotePath(path);
    const file = await prepareProviderMutation(() => this.resolveFile(path));
    if (file === null) return;
    // Trash, never `DELETE /files/{id}` (#750): a permanent delete bypasses
    // Drive's 30-day trash and made the #741 blob wipe unrecoverable. Every
    // read path filters `trashed = false`, so a trashed object is already
    // absent to list/verify/restore while staying user-recoverable.
    const response = await this.authorizedFetch(`${API}/files/${encodeURIComponent(file.id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ trashed: true }),
    });
    if (!response.ok && response.status !== 404) throw await this.responseError(response, 'delete');
    this.options.paths.setFileId(this.pathLibraryId(), path, null);
    this.validatedIds.delete(file.id);
  }

  async quota(signal?: AbortSignal): Promise<ProviderQuota> {
    const url = new URL(`${API}/about`);
    url.searchParams.set('fields', 'storageQuota(usage,limit)');
    const data = await this.json(url.toString(), undefined, 'read quota', signal);
    const storageQuota =
      typeof data['storageQuota'] === 'object' && data['storageQuota'] !== null ? (data['storageQuota'] as Record<string, unknown>) : {};
    const usedBytes = bytesOf(storageQuota['usage']);
    const totalBytes = bytesOf(storageQuota['limit']);
    if (usedBytes === null) throw new ProviderError('Google Drive quota returned no usage', 'transient');
    return { usedBytes, totalBytes };
  }

  async verify(path: string): Promise<{ sha256: string; bytes: number }> {
    assertSafeRemotePath(path);
    const file = await this.resolveFile(path, true);
    if (file === null) throw new ProviderError(`no Google Drive entry at ${path}`, 'not-found');
    const bytes = bytesOf(file.metadata.size);
    const sha256 = typeof file.metadata.sha256Checksum === 'string' ? file.metadata.sha256Checksum.toLowerCase() : null;
    if (bytes !== null && sha256 !== null && /^[a-f0-9]{64}$/u.test(sha256)) return { sha256, bytes };
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

  private properties(identity: string): Record<string, string> {
    return {
      [GOOGLE_DRIVE_DISCOVERY_PROTOCOL.ownerPropertyKey]: this.owner,
      [GOOGLE_DRIVE_DISCOVERY_PROTOCOL.pathHashPropertyKey]: googleDriveDiscoveryHash(identity),
    };
  }

  private pathLibraryId(libraryId = this.options.libraryId): string {
    if (this.rootName === 'Overlook' && this.owner === BACKUP_OWNER) return libraryId;
    return `interop_${googleDriveDiscoveryHash(`${this.rootName}\0${this.owner}\0${libraryId}`).slice(0, 56)}`;
  }

  private cachedRootId(): string | null {
    if (this.rootName === 'Overlook' && this.owner === BACKUP_OWNER) return this.options.paths.overlookFolderId();
    return this.options.paths.folderId(`root_${googleDriveDiscoveryHash(`${this.rootName}\0${this.owner}`).slice(0, 59)}`, '');
  }

  private setCachedRootId(id: string | null): void {
    if (this.rootName === 'Overlook' && this.owner === BACKUP_OWNER) {
      this.options.paths.setOverlookFolderId(id);
      return;
    }
    this.options.paths.setFolderId(`root_${googleDriveDiscoveryHash(`${this.rootName}\0${this.owner}`).slice(0, 59)}`, '', id);
  }

  private async walk(folderId: string, relativePath: string, out: RemoteEntry[], signal?: AbortSignal): Promise<void> {
    for (const child of await this.listChildren(folderId, signal)) {
      signal?.throwIfAborted();
      const id = idOf(child);
      const name = typeof child.name === 'string' ? child.name : null;
      if (id === null || name === null || name.includes('/')) continue;
      const childPath = relativePath === '' ? name : `${relativePath}/${name}`;
      if (isFolder(child)) {
        this.options.paths.setFolderId(this.pathLibraryId(), childPath, id);
        await this.walk(id, childPath, out, signal);
      } else {
        const bytes = bytesOf(child.size);
        if (bytes !== null) {
          this.options.paths.setFileId(this.pathLibraryId(), childPath, id);
          out.push({ path: childPath, bytes });
        }
      }
    }
  }

  private async resolveOverlookFolder(create: boolean, signal?: AbortSignal): Promise<string | null> {
    const cached = this.cachedRootId();
    if (cached !== null && (await this.validFolder(cached, signal))) return cached;
    if (cached !== null) this.setCachedRootId(null);
    const identity = googleDriveRootIdentity();
    const found = await this.findOne(
      [
        `name = '${quoteQuery(this.rootName)}'`,
        `mimeType = '${FOLDER_MIME}'`,
        `'root' in parents`,
        `trashed = false`,
        this.propertyQuery(identity),
      ],
      signal,
    );
    const foundId = found === null ? null : idOf(found);
    if (foundId !== null) {
      this.setCachedRootId(foundId);
      this.validatedIds.add(foundId);
      return foundId;
    }
    if (!create) return null;
    const id = await this.createFolder(this.rootName, 'root', identity);
    this.setCachedRootId(id);
    return id;
  }

  private async resolveFolder(path: string, create: boolean, signal?: AbortSignal): Promise<string | null> {
    if (path !== '') assertSafeRemotePath(path);
    const cacheLibraryId = this.pathLibraryId();
    const cached = this.options.paths.folderId(cacheLibraryId, path);
    if (cached !== null && (await this.validFolder(cached, signal))) return cached;
    if (cached !== null) this.options.paths.setFolderId(cacheLibraryId, path, null);

    const root = await this.resolveOverlookFolder(create, signal);
    if (root === null) return null;
    if (path === '') {
      const identity = googleDriveLibraryIdentity(this.options.libraryId);
      const found = await this.findOne(
        [
          `name = '${quoteQuery(this.options.libraryId)}'`,
          `mimeType = '${FOLDER_MIME}'`,
          `'${quoteQuery(root)}' in parents`,
          'trashed = false',
          this.propertyQuery(identity),
        ],
        signal,
      );
      let id = found === null ? null : idOf(found);
      if (id === null && create) id = await this.createFolder(this.options.libraryId, root, identity);
      if (id !== null) this.options.paths.setFolderId(cacheLibraryId, '', id);
      return id;
    }

    const parentPath = posix.dirname(path) === '.' ? '' : posix.dirname(path);
    const parentId = await this.resolveFolder(parentPath, create, signal);
    if (parentId === null) return null;
    const name = posix.basename(path);
    const identity = googleDriveFolderIdentity(this.options.libraryId, path);
    const found = await this.findOne(
      [
        `name = '${quoteQuery(name)}'`,
        `mimeType = '${FOLDER_MIME}'`,
        `'${quoteQuery(parentId)}' in parents`,
        'trashed = false',
        this.propertyQuery(identity),
      ],
      signal,
    );
    let id = found === null ? null : idOf(found);
    if (id === null && create) id = await this.createFolder(name, parentId, identity);
    if (id !== null) this.options.paths.setFolderId(cacheLibraryId, path, id);
    return id;
  }

  private async resolveFile(path: string, refresh = false, signal?: AbortSignal): Promise<{ id: string; metadata: DriveFile } | null> {
    assertSafeRemotePath(path);
    const cacheLibraryId = this.pathLibraryId();
    const cached = this.options.paths.fileId(cacheLibraryId, path);
    if (cached !== null) {
      const metadata = await this.validFile(cached, refresh, signal);
      if (metadata !== null) return { id: cached, metadata };
      this.options.paths.setFileId(cacheLibraryId, path, null);
    }
    const parentPath = posix.dirname(path) === '.' ? '' : posix.dirname(path);
    const parentId = await this.resolveFolder(parentPath, false, signal);
    if (parentId === null) return null;
    const identity = googleDriveFileIdentity(this.options.libraryId, path);
    const found = await this.findOne(
      [
        `name = '${quoteQuery(posix.basename(path))}'`,
        `mimeType != '${FOLDER_MIME}'`,
        `'${quoteQuery(parentId)}' in parents`,
        'trashed = false',
        this.propertyQuery(identity),
      ],
      signal,
    );
    const id = found === null ? null : idOf(found);
    if (id === null) return null;
    this.options.paths.setFileId(cacheLibraryId, path, id);
    this.validatedIds.add(id);
    return { id, metadata: found as DriveFile };
  }

  private propertyQuery(identity: string): string {
    return `appProperties has { key='${GOOGLE_DRIVE_DISCOVERY_PROTOCOL.ownerPropertyKey}' and value='${this.owner}' } and appProperties has { key='${GOOGLE_DRIVE_DISCOVERY_PROTOCOL.pathHashPropertyKey}' and value='${googleDriveDiscoveryHash(identity)}' }`;
  }

  private async validFolder(id: string, signal?: AbortSignal): Promise<boolean> {
    if (this.validatedIds.has(id)) return true;
    const metadata = await this.metadataOrNull(id, signal);
    if (metadata !== null && isFolder(metadata)) {
      this.validatedIds.add(id);
      return true;
    }
    return false;
  }

  private async validFile(id: string, refresh: boolean, signal?: AbortSignal): Promise<DriveFile | null> {
    if (!refresh && this.validatedIds.has(id)) return { id };
    const metadata = await this.metadataOrNull(id, signal);
    if (metadata !== null && !isFolder(metadata) && metadata.trashed !== true) {
      this.validatedIds.add(id);
      return metadata;
    }
    return null;
  }

  private async metadataOrNull(id: string, signal?: AbortSignal): Promise<DriveFile | null> {
    const url = new URL(`${API}/files/${encodeURIComponent(id)}`);
    url.searchParams.set('fields', FILE_FIELDS);
    try {
      return await this.json(url.toString(), undefined, 'read file metadata', signal);
    } catch (error) {
      if (error instanceof ProviderError && error.kind === 'not-found') return null;
      throw error;
    }
  }

  private async createFolder(name: string, parentId: string, identity: string): Promise<string> {
    const data = await this.json(
      `${API}/files?fields=id`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId], appProperties: this.properties(identity) }),
      },
      'create folder',
    );
    const id = typeof data['id'] === 'string' ? data['id'] : null;
    if (id === null) throw new ProviderError('Google Drive folder creation returned no id', 'transient');
    this.validatedIds.add(id);
    return id;
  }

  private async findOne(clauses: readonly string[], signal?: AbortSignal): Promise<DriveFile | null> {
    const files = await this.listQuery(clauses.join(' and '), signal);
    return files.sort((a, b) => String(a.id).localeCompare(String(b.id)))[0] ?? null;
  }

  private listChildren(parentId: string, signal?: AbortSignal): Promise<DriveFile[]> {
    return this.listQuery(`'${quoteQuery(parentId)}' in parents and trashed = false`, signal);
  }

  private async listQuery(query: string, signal?: AbortSignal): Promise<DriveFile[]> {
    const files: DriveFile[] = [];
    let pageToken: string | null = null;
    do {
      signal?.throwIfAborted();
      const url = new URL(`${API}/files`);
      url.searchParams.set('q', query);
      url.searchParams.set('spaces', 'drive');
      url.searchParams.set('pageSize', '1000');
      url.searchParams.set('fields', `nextPageToken,files(${FILE_FIELDS})`);
      if (pageToken !== null) url.searchParams.set('pageToken', pageToken);
      const data = (await this.json(url.toString(), undefined, 'list files', signal)) as DriveFileList;
      if (Array.isArray(data.files)) files.push(...(data.files as DriveFile[]));
      pageToken = typeof data.nextPageToken === 'string' && data.nextPageToken !== '' ? data.nextPageToken : null;
    } while (pageToken !== null);
    return files;
  }

  private async uploadSession(session: string, bytes: Readable): Promise<DriveFile> {
    const iterator = bytes[Symbol.asyncIterator]();
    const pending: Buffer[] = [];
    let pendingBytes = 0;
    let sourceDone = false;

    const fill = async (minBytes: number): Promise<void> => {
      while (!sourceDone && pendingBytes < minBytes) {
        const next = await iterator.next();
        if (next.done) {
          sourceDone = true;
          break;
        }
        const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value as Uint8Array);
        if (chunk.length > 0) {
          pending.push(chunk);
          pendingBytes += chunk.length;
        }
      }
    };

    const take = (count: number): Buffer => {
      if (count === 0) return Buffer.alloc(0);
      const first = pending[0];
      if (first !== undefined && first.length === count) {
        pending.shift();
        pendingBytes -= count;
        return first;
      }
      const out = Buffer.allocUnsafe(count);
      let written = 0;
      while (written < count && pending.length > 0) {
        const head = pending[0]!;
        const copyLen = Math.min(head.length, count - written);
        head.copy(out, written, 0, copyLen);
        written += copyLen;
        pendingBytes -= copyLen;
        if (copyLen === head.length) pending.shift();
        else pending[0] = head.subarray(copyLen);
      }
      return out;
    };

    try {
      let offset = 0;
      let stalls = 0;
      let isFinal = false;
      do {
        await fill(this.chunkBytes + 1);
        isFinal = pendingBytes <= this.chunkBytes;
        const window = take(isFinal ? pendingBytes : this.chunkBytes);
        const windowStart = offset;
        const windowEnd = windowStart + window.length;
        const totalBytes = isFinal ? windowEnd : null;
        do {
          const chunk = window.length === 0 ? Buffer.alloc(0) : window.subarray(offset - windowStart);
          const contentRange =
            totalBytes === 0
              ? 'bytes */0'
              : totalBytes === null
                ? `bytes ${String(offset)}-${String(windowEnd - 1)}/*`
                : `bytes ${String(offset)}-${String(windowEnd - 1)}/${String(totalBytes)}`;
          let response: Response;
          try {
            response = await this.authorizedFetch(session, {
              method: 'PUT',
              headers: {
                'content-length': String(chunk.length),
                'content-range': contentRange,
              },
              body: chunk,
            });
          } catch (error) {
            if (!(error instanceof ProviderError) || error.kind !== 'transient') throw error;
            response = await this.queryUpload(session, totalBytes);
          }
          if (response.status === 200 || response.status === 201) return (await response.json()) as DriveFile;
          if (response.status !== 308) {
            if (response.status >= 500 || response.status === 429) response = await this.queryUpload(session, totalBytes);
            if (response.status === 200 || response.status === 201) return (await response.json()) as DriveFile;
            if (response.status !== 308) throw await this.responseError(response, 'resume upload');
          }
          const next = rangeOffset(response.headers.get('range'));
          if (next > windowEnd) {
            throw new ProviderError('Google Drive returned an out-of-bounds resumable upload range', 'transient');
          }
          stalls = next <= offset ? stalls + 1 : 0;
          if (stalls >= 4) throw new ProviderError('Google Drive resumable upload made no progress', 'transient');
          offset = next;
        } while (offset < windowEnd || totalBytes === 0);
      } while (!isFinal);
      throw new ProviderError('Google Drive resumable upload ended without file metadata', 'transient');
    } finally {
      bytes.destroy();
    }
  }

  private queryUpload(session: string, totalBytes: number | null): Promise<Response> {
    return this.authorizedFetch(session, {
      method: 'PUT',
      headers: {
        'content-length': '0',
        'content-range': `bytes */${totalBytes === null ? '*' : String(totalBytes)}`,
      },
      body: Buffer.alloc(0),
    });
  }

  private async json(
    url: string,
    init: RequestInit | undefined,
    operation: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const response = await this.authorizedFetch(url, signal === undefined ? init : { ...init, signal });
    if (!response.ok) throw await this.responseError(response, operation);
    return (await response.json()) as Record<string, unknown>;
  }

  private async authorizedFetch(url: string, init: RequestInit = {}, retried = false): Promise<Response> {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || (parsed.hostname !== 'www.googleapis.com' && parsed.hostname !== 'content.googleapis.com')) {
      throw new ProviderError('refusing to send Google credentials to an unexpected host', 'corrupt');
    }
    const token = await this.options.auth.accessToken(retried, init.signal ?? undefined);
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${token}`);
    let response: Response;
    try {
      response = await this.fetchImpl(url, { ...init, headers });
    } catch {
      throw new ProviderError('Google Drive request failed: network failure', 'transient');
    }
    if (response.status === 401 && !retried) {
      this.options.auth.invalidate();
      return this.authorizedFetch(url, init, true);
    }
    return response;
  }

  private async responseError(response: Response, operation: string): Promise<ProviderError> {
    const body = (await response.json().catch(() => ({}))) as {
      readonly error?: { readonly errors?: readonly { readonly reason?: unknown }[] };
    };
    const rawReason = body.error?.errors?.[0]?.reason;
    const reason = typeof rawReason === 'string' ? rawReason : null;
    return new ProviderError(
      `Google Drive ${operation} failed: HTTP ${String(response.status)}${reason === null ? '' : ` (${reason})`}`,
      providerKind(response.status, reason),
    );
  }
}
