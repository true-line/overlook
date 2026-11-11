const KEY_BYTES = 32;

export class ProtectedAlbumAuthorityError extends Error {
  override readonly name = 'ProtectedAlbumAuthorityError';
}

export interface ProtectedAlbumAuthoritySnapshot {
  readonly albumId: string;
  readonly generation: number;
}

export type ProtectedAlbumRevocationListener = (albumId: string) => void;

/** Main-process-only session custody. The registry owns every stored copy and
 * zeroizes it on replacement, relock, app lock, or library shutdown. */
export class ProtectedAlbumAuthorityRegistry {
  private readonly keys = new Map<string, Buffer>();
  private readonly generations = new Map<string, number>();
  private readonly listeners = new Set<ProtectedAlbumRevocationListener>();

  authorize(albumId: string, albumKey: Buffer): void {
    if (albumId.length < 1 || albumId.length > 256) throw new ProtectedAlbumAuthorityError('album id is invalid');
    if (albumKey.length !== KEY_BYTES) throw new ProtectedAlbumAuthorityError('album key must be 32 bytes');
    const previous = this.keys.get(albumId);
    this.generations.set(albumId, (this.generations.get(albumId) ?? 0) + 1);
    this.keys.set(albumId, Buffer.from(albumKey));
    previous?.fill(0);
    if (previous !== undefined) this.emitRevoked(albumId);
  }

  isAuthorized(albumId: string): boolean {
    return this.keys.has(albumId);
  }

  /** The callback must not retain the Buffer; it is registry-owned and can be
   * zeroized by a lifecycle event immediately after this call. */
  withAuthority<T>(albumId: string, use: (albumKey: Buffer) => T): T {
    const key = this.keys.get(albumId);
    if (key === undefined) throw new ProtectedAlbumAuthorityError('protected album is locked');
    return use(key);
  }

  snapshot(albumId: string): ProtectedAlbumAuthoritySnapshot {
    if (!this.keys.has(albumId)) throw new ProtectedAlbumAuthorityError('protected album is locked');
    return { albumId, generation: this.generations.get(albumId) ?? 0 };
  }

  isCurrent(snapshot: ProtectedAlbumAuthoritySnapshot): boolean {
    return this.keys.has(snapshot.albumId) && this.generations.get(snapshot.albumId) === snapshot.generation;
  }

  withSnapshot<T>(snapshot: ProtectedAlbumAuthoritySnapshot, use: (albumKey: Buffer) => T): T {
    if (!this.isCurrent(snapshot)) throw new ProtectedAlbumAuthorityError('protected album is locked');
    return this.withAuthority(snapshot.albumId, use);
  }

  onRevoked(listener: ProtectedAlbumRevocationListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  relock(albumId: string): boolean {
    const key = this.keys.get(albumId);
    if (key === undefined) return false;
    this.keys.delete(albumId);
    this.generations.set(albumId, (this.generations.get(albumId) ?? 0) + 1);
    key.fill(0);
    this.emitRevoked(albumId);
    return true;
  }

  relockAll(): void {
    const albumIds = [...this.keys.keys()];
    for (const key of this.keys.values()) key.fill(0);
    this.keys.clear();
    for (const albumId of albumIds) {
      this.generations.set(albumId, (this.generations.get(albumId) ?? 0) + 1);
      this.emitRevoked(albumId);
    }
  }

  close(): void {
    this.relockAll();
    this.listeners.clear();
  }

  private emitRevoked(albumId: string): void {
    for (const listener of this.listeners) {
      try {
        listener(albumId);
      } catch {
        // Revocation must reach every cache even if one observer is faulty.
      }
    }
  }
}
