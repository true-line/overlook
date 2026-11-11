import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

import { LibraryRegistry, LibraryRegistryError, ensureDefaultEntry } from './library-registry.js';
import { readOrMintLibraryId, writeLibraryId } from './library-id.js';
import { KeyStore, type SafeStorageLike } from '../crypto/keystore.js';
import { installedLibraryMasterBackup, LibraryMasterBackupError } from '../crypto/library-master-port.js';
import { openLibraryDatabase } from '../db/database.js';
import { ulid } from '../import/ulid.js';
import {
  libraryDisplayNameSchema,
  truncateLibraryDisplayName,
  type LibraryDescriptor,
  type LibraryEntry,
} from '../../shared/library/registry.js';
import { ensureLibraryDocumentPath, isLibraryDocumentPath } from '../../shared/library/library-document.js';
import { LibraryDocumentRouter } from './library-document-router.js';
import { updateLibraryDocumentSummaryName, writeLibraryDocumentSummary } from './library-document-summary.js';
import type { SwitchOutcome } from './switch-runtime.js';

// Active-library resolution (ADR-0017 §1/§7, #384), extracted from the
// composition root: the registry replaces the hardcoded userData/library.
// Existing installs resolve to the same directory via the register-in-place
// migration; the live switch arrives with #385.

/** The directory never became a library. Drop its master copy with the files. */
function discardCreatedLibrary(dir: string, libraryId: string): void {
  rmSync(dir, { recursive: true, force: true });
  try {
    installedLibraryMasterBackup().remove(libraryId);
  } catch (error) {
    const code = error instanceof LibraryMasterBackupError ? error.code : 'unavailable';
    console.error('[overlook] library master backup remove failed', code);
  }
}

export interface LibraryRegistryRuntimeOptions {
  readonly userDataDir: () => string;
  /** Live-lock probe for descriptors (#386): hostname of ANOTHER instance
   * holding a library's advisory lock, or null. Absent = never locked
   * (tests, pre-#386 callers). */
  readonly lockHolder?: (dir: string) => string | null;
}

function missingDirectoryError(dir: string): LibraryRegistryError {
  return new LibraryRegistryError(`library directory is missing: ${dir} — reconnect the volume or locate/remove the library`);
}

export class LibraryRegistryRuntime {
  private registry: LibraryRegistry | undefined;
  private active: LibraryEntry | undefined;
  private closeSummary: (() => void) | undefined;
  /** Fresh-profile default (§7): held in memory only — registering it (and
   * creating its directory) waits for the first real open, because startup
   * must leave a fresh profile pristine. A restore into a fresh profile
   * requires an EMPTY target directory (restore-staging destructive-
   * authorization guard); an eagerly minted library-id file would break it. */
  private virtualDefault: LibraryEntry | undefined;

  constructor(private readonly options: LibraryRegistryRuntimeOptions) {}

  registryPath(): string {
    return path.join(this.options.userDataDir(), 'libraries.json');
  }

  /** The pre-registry hardcoded directory — the migration target (§7). */
  legacyDir(): string {
    return path.join(this.options.userDataDir(), 'library');
  }

  getRegistry(): LibraryRegistry {
    this.registry ??= new LibraryRegistry({ filePath: this.registryPath() });
    return this.registry;
  }

  resolveActive(): LibraryEntry {
    if (this.active !== undefined) return this.active;
    // Once startup chose a virtual default, registry mutations must not
    // silently repoint the dataDir-bound runtime. In particular, registering
    // an existing library from fresh-profile onboarding must leave the
    // virtual default active until the explicit switch selects, app-lock
    // swaps to, and reloads into that library.
    if (this.virtualDefault !== undefined) return this.virtualDefault;
    const registry = this.getRegistry();
    const existing = registry.startupEntry();
    if (existing !== undefined) {
      this.active = existing;
      return existing;
    }
    if (existsSync(path.join(this.legacyDir(), 'library.db'))) {
      // Existing pre-registry install: register it in place (§7).
      this.active = ensureDefaultEntry(registry, {
        legacyDir: this.legacyDir(),
        libraryId: () => readOrMintLibraryId(this.legacyDir()),
      });
      return this.active;
    }
    this.virtualDefault ??= {
      id: ulid(),
      name: 'My Library',
      path: this.legacyDir(),
      createdAt: new Date().toISOString(),
      lastOpenedAt: null,
    };
    return this.virtualDefault;
  }

  dataDir(): string {
    return this.resolveActive().path;
  }

  /** Maintains the bounded, derivative Finder projection for the open package.
   * Projection failures never interrupt canonical encrypted-library work. */
  followDocumentSummary(itemCount: () => number, subscribe: (listener: () => void) => () => void): void {
    const refresh = (): void => {
      const active = this.resolveActive();
      try {
        writeLibraryDocumentSummary(active.path, {
          version: 1,
          name: active.name,
          itemCount: itemCount(),
          updatedAt: new Date().toISOString(),
        });
      } catch (error) {
        console.error('[overlook] library document summary refresh failed', error);
      }
    };
    this.closeDocumentSummary();
    refresh();
    this.closeSummary = subscribe(refresh);
  }

  closeDocumentSummary(): void {
    this.closeSummary?.();
    this.closeSummary = undefined;
  }

  /** Creates one serialized Finder-document handler that can repair a moved
   * startup target before the missing-path startup failure gate runs. */
  documentHandler(open: (id: string) => Promise<SwitchOutcome>, failure: (message: string) => void): (directory: string) => Promise<void> {
    return async (directory) => {
      try {
        await new LibraryDocumentRouter({ registry: this.getRegistry(), open, failure }).open(directory);
      } catch {
        failure('The library registry is unavailable.');
      }
    };
  }

  /** Fail loud, fail closed (§1): a corrupt registry must never be
   * overwritten with an empty one, and with no recovery UI yet (#386) the
   * only honest move is to report and exit — the file is left untouched.
   * Returns the user-facing message, or null when resolution succeeds. */
  resolveFailure(): string | null {
    try {
      const entry = this.resolveActive();
      // A registered active library whose directory vanished must fail loud
      // at STARTUP too (PR #425 review): past this gate the restore flow
      // reads the missing library.db as "fresh profile" and onboarding
      // would target the dead path. The virtual default is exempt — its
      // directory is only created on first open.
      if (this.active !== undefined && !existsSync(entry.path)) {
        throw missingDirectoryError(entry.path);
      }
      return null;
    } catch (error) {
      if (error instanceof LibraryRegistryError) {
        return `${error.message}\n\nOverlook will not overwrite ${this.registryPath()}. Restore or remove that file, then relaunch.`;
      }
      throw error;
    }
  }

  /** Open-time identity check (§2): the directory's library-id file is
   * authoritative — minted here if absent — and heals the registry's cached
   * id if they diverge. First open of a fresh profile materializes the
   * virtual default: this is the moment the legacy directory may be created
   * and the entry registered (§7). Returns the healed entry. */
  healActiveId(): LibraryEntry {
    const entry = this.resolveActive();
    if (this.active === undefined) {
      const idPath = path.join(entry.path, 'library-id');
      if (!existsSync(idPath)) writeLibraryId(entry.path, entry.id);
      const directoryId = readOrMintLibraryId(entry.path);
      this.active = this.getRegistry().register({ ...entry, id: directoryId });
      this.virtualDefault = undefined;
      return this.active;
    }
    // A registered directory that vanished (unplugged volume, moved path)
    // must fail loud (#385): the id-mint below would otherwise mkdir and
    // silently provision a fresh empty library where the real one lived.
    if (!existsSync(entry.path)) {
      throw missingDirectoryError(entry.path);
    }
    const directoryId = readOrMintLibraryId(entry.path);
    if (directoryId !== entry.id) {
      this.active = this.getRegistry().updateId(entry.id, directoryId);
    }
    return this.active ?? entry;
  }

  /** Stamped at successful DB open — not at close, so a crash never loses
   * the startup selection (§1). */
  markOpened(): LibraryEntry {
    this.active = this.getRegistry().touchOpened(this.resolveActive().id);
    return this.active;
  }

  /** IPC-facing view: registry fields + derived status, computed at read
   * time and never persisted (§1). openId is the id of the library the
   * process currently has open, or null before first bootstrap. */
  describe(entry: LibraryEntry, openId: string | null): LibraryDescriptor {
    const missing = !existsSync(entry.path);
    const open = entry.id === openId;
    return { ...entry, missing, open, lockedBy: missing || open ? null : (this.options.lockHolder?.(entry.path) ?? null) };
  }

  list(openId: string | null): LibraryDescriptor[] {
    return this.getRegistry()
      .list()
      .map((entry) => this.describe(entry, openId));
  }

  current(openId: string | null): LibraryDescriptor {
    return this.describe(this.resolveActive(), openId);
  }

  /** Create = provision, not open (§3): pin the identity, let KeyStore mint
   * the master key + KEY #1, close it (keys stay cold until open), register.
   * A create that fails midway deletes a directory it created — before the
   * first successful open the directory is disposable. */
  create(options: { name: string; path: string | null; safeStorage: SafeStorageLike }): LibraryEntry {
    const parsedName = libraryDisplayNameSchema.safeParse(options.name);
    if (!parsedName.success) {
      throw new LibraryRegistryError(parsedName.error.issues[0]?.message ?? 'invalid library display name');
    }
    const id = ulid();
    const dir = options.path === null ? path.join(this.options.userDataDir(), 'libraries', id) : ensureLibraryDocumentPath(options.path);
    if (existsSync(dir) && readdirSync(dir).length > 0) {
      throw new LibraryRegistryError(`target directory is not empty: ${dir}`);
    }
    const createdDir = !existsSync(dir);
    const createdAt = new Date().toISOString();
    mkdirSync(dir, { recursive: true });
    try {
      writeLibraryId(dir, id);
      const keyStore = KeyStore.open({ safeStorage: options.safeStorage, dataDir: dir });
      try {
        // Provision the empty database too (#385): the renderer's restore
        // gate treats a missing library.db as "fresh profile", and a created
        // library must open into its (empty) grid, not into onboarding.
        const dbKey = keyStore.resolver()(1);
        if (dbKey === undefined) throw new LibraryRegistryError('created key store has no KEY #1');
        const db = openLibraryDatabase({ path: path.join(dir, 'library.db'), dbKey });
        db.pragma('wal_checkpoint(TRUNCATE)');
        db.close();
        writeLibraryDocumentSummary(dir, { version: 1, name: parsedName.data, itemCount: 0, updatedAt: createdAt });
      } finally {
        keyStore.close();
      }
      return this.getRegistry().register({
        id,
        name: parsedName.data,
        path: dir,
        createdAt,
        lastOpenedAt: null,
      });
    } catch (error) {
      if (createdDir) discardCreatedLibrary(dir, id);
      throw error;
    }
  }

  /** Register an EXISTING library directory (#386): the directory's own
   * library-id is authoritative (minted only when a real library.db exists
   * without one — pre-#384 installs). Never touches library contents. */
  addExisting(
    dir: string,
    openId: string | null,
  ): { ok: true; library: LibraryDescriptor } | { ok: false; reason: 'not-a-library' | 'already-registered' } {
    if (!existsSync(path.join(dir, 'library.db'))) {
      return { ok: false, reason: 'not-a-library' };
    }
    const id = readOrMintLibraryId(dir);
    try {
      const entry = this.getRegistry().register({
        id,
        name: truncateLibraryDisplayName(path.basename(dir, isLibraryDocumentPath(dir) ? path.extname(dir) : undefined)),
        path: dir,
        createdAt: new Date().toISOString(),
        lastOpenedAt: null,
      });
      return { ok: true, library: this.describe(entry, openId) };
    } catch (error) {
      if (error instanceof LibraryRegistryError) {
        return { ok: false, reason: 'already-registered' };
      }
      throw error;
    }
  }

  /** Switch pre-flight (#386): why the target cannot be opened right now, or
   * null when it can. Unregistered ids fall through to select()'s loud throw. */
  probeSwitchTarget(id: string): { reason: 'missing' | 'locked-elsewhere'; host: string | null } | null {
    const entry = this.getRegistry().get(id);
    if (entry === undefined) return null;
    if (!existsSync(entry.path)) return { reason: 'missing', host: null };
    const host = this.options.lockHolder?.(entry.path) ?? null;
    return host === null ? null : { reason: 'locked-elsewhere', host };
  }

  /** Select which library the NEXT bootstrap opens. The live in-process
   * switch is #385's contract (ADR-0017 §4); until it lands, selecting while
   * a different library is open reports requiresRestart. */
  select(id: string, openId: string | null): { library: LibraryDescriptor; requiresRestart: boolean } {
    const entry = this.getRegistry().get(id);
    if (entry === undefined) throw new LibraryRegistryError(`library ${id} is not registered`);
    const current = this.resolveActive();
    if (entry.id === current.id) {
      // Same id is NOT the same entry: relocation (#483, ADR-0022) rewrites
      // the path under an unchanged id, so a same-id select refreshes the
      // cached entry from the registry file — serving the cached object here
      // left the runtime bound to a moved library's deleted source path
      // (PR #553 review).
      if (this.active !== undefined) this.active = entry;
      return { library: this.describe(this.active ?? current, openId), requiresRestart: false };
    }
    if (!existsSync(entry.path)) {
      throw new LibraryRegistryError(`library directory is missing: ${entry.path}`);
    }
    // lastOpenedAt doubles as the selection record — it is what startup
    // resolution orders by (§1); the real open re-stamps it.
    const selected = this.getRegistry().touchOpened(id);
    if (openId !== null) {
      return { library: this.describe(selected, openId), requiresRestart: true };
    }
    this.active = selected;
    return { library: this.describe(selected, openId), requiresRestart: false };
  }

  /** Registry-only display-name mutation (#685). Refresh the active cache so
   * current() and every subsequent descriptor serve the new alias without a
   * restart; library contents and the directory path are never touched. */
  setDisplayName(id: string, name: string, openId: string | null): LibraryDescriptor {
    const renamed = this.getRegistry().rename(id, name);
    updateLibraryDocumentSummaryName(renamed.path, renamed.name);
    if (this.active?.id === id) this.active = renamed;
    return this.describe(renamed, openId);
  }

  resetDisplayName(id: string, openId: string | null): LibraryDescriptor {
    const entry = this.getRegistry().get(id);
    if (entry === undefined) throw new LibraryRegistryError(`library ${id} is not registered`);
    const suffix = isLibraryDocumentPath(entry.path) ? path.extname(entry.path) : undefined;
    return this.setDisplayName(id, truncateLibraryDisplayName(path.basename(entry.path, suffix)), openId);
  }

  /** The IPC facade (structurally matches ipc.ts LibraryRegistryFacade).
   * openLibraryId reports what the process has open — null before bootstrap. */
  facade(deps: {
    openLibraryId: () => string | null;
    lockedLibraryId?: () => string | null;
    safeStorage: () => SafeStorageLike;
    /** Native directory picker (#386) — resolves null on cancel. */
    pickDirectory: () => Promise<string | null>;
    /** Save-style package picker (#799) — resolves null on cancel. */
    pickCreateLocation: () => Promise<string | null>;
  }): {
    list: () => LibraryDescriptor[];
    create: (name: string, dir: string | null) => LibraryDescriptor;
    open: (id: string) => { library: LibraryDescriptor; requiresRestart: boolean };
    setDisplayName: (id: string, name: string) => LibraryDescriptor;
    resetDisplayName: (id: string) => LibraryDescriptor;
    remove: (id: string) => boolean;
    current: () => LibraryDescriptor;
    add: (
      dir: string | null,
    ) => Promise<{ ok: true; library: LibraryDescriptor } | { ok: false; reason: 'cancelled' | 'not-a-library' | 'already-registered' }>;
    pickLocation: () => Promise<{ path: string | null }>;
    pickCreateLocation: () => Promise<{ path: string | null }>;
  } {
    return {
      list: () => this.list(deps.openLibraryId()),
      create: (name, dir) => this.describe(this.create({ name, path: dir, safeStorage: deps.safeStorage() }), deps.openLibraryId()),
      open: (id) => this.select(id, deps.openLibraryId()),
      setDisplayName: (id, name) => this.setDisplayName(id, name, deps.openLibraryId()),
      resetDisplayName: (id) => this.resetDisplayName(id, deps.openLibraryId()),
      remove: (id) => this.removeEntry(id, deps.openLibraryId(), deps.lockedLibraryId?.() ?? null),
      current: () => this.current(deps.openLibraryId()),
      add: async (dir) => {
        const chosen = dir ?? (await deps.pickDirectory());
        if (chosen === null) return { ok: false, reason: 'cancelled' };
        return this.addExisting(chosen, deps.openLibraryId());
      },
      pickLocation: async () => ({ path: await deps.pickDirectory() }),
      pickCreateLocation: async () => ({ path: await deps.pickCreateLocation() }),
    };
  }

  /** Registry-entry removal only — the directory, keys, and DB stay intact
   * (§1; destructive deletion is a separate, explicit action). */
  removeEntry(id: string, openId: string | null, lockedId: string | null = null): boolean {
    if (id === openId) {
      throw new LibraryRegistryError('cannot remove the library that is currently open');
    }
    if (id === lockedId) {
      throw new LibraryRegistryError('cannot remove the active library while it is locked');
    }
    const removed = this.getRegistry().remove(id);
    if (removed && this.active?.id === id) {
      this.active = undefined;
    }
    return removed;
  }
}
