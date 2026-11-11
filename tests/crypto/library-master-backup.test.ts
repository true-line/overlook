import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { OVERLOOK_LIBRARY_MASTER_SERVICE } from '../../src/shared/app-identity.js';
import { KeyStore, probeMasterUnwrap, type SafeStorageLike } from '../../src/main/crypto/keystore.js';
import { createLibraryMasterBackup } from '../../src/main/crypto/library-master-native.js';
import { LibraryMasterBackupError, type LibraryMasterBackup } from '../../src/main/crypto/library-master-port.js';
import { probeLibraryCustody } from '../../src/main/crypto/library-master-restore.js';
import { writeLibraryId } from '../../src/main/library/library-id.js';

const LIBRARY_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

class FakeBackup implements LibraryMasterBackup {
  readonly items = new Map<string, string>();
  reads = 0;
  writes = 0;
  failWrite = false;
  readError: Error | null = null;

  read(libraryId: string): string | null {
    this.reads += 1;
    if (this.readError !== null) throw this.readError;
    return this.items.get(libraryId) ?? null;
  }

  write(libraryId: string, canonicalBase64: string): void {
    this.writes += 1;
    if (this.failWrite) throw new LibraryMasterBackupError('unavailable');
    this.items.set(libraryId, canonicalBase64);
  }

  remove(libraryId: string): void {
    this.items.delete(libraryId);
  }
}

function fakeSafeStorage(pad: number, available = true): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) => Buffer.from(Buffer.from(plain, 'utf8').map((byte) => byte ^ pad)),
    decryptString: (encrypted) => Buffer.from(encrypted.map((byte) => byte ^ pad)).toString('utf8'),
  };
}

function throwingSafeStorage(pad: number): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => Buffer.from(Buffer.from(plain, 'utf8').map((byte) => byte ^ pad)),
    decryptString: () => {
      throw new Error('unwrap');
    },
  };
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'overlook-master-backup-'));
}

function openedLibrary(backup: FakeBackup): { dataDir: string; safeStorage: SafeStorageLike } {
  const dataDir = tempDir();
  writeLibraryId(dataDir, LIBRARY_ID);
  const safeStorage = fakeSafeStorage(0x5a);
  KeyStore.open({ safeStorage, dataDir, masterBackup: backup });
  return { dataDir, safeStorage };
}

describe('library master backup (#1321, ADR-0035)', () => {
  test('a create stores canonical base64 under the library ULID and a later open replaces it', () => {
    const backup = new FakeBackup();
    const { dataDir, safeStorage } = openedLibrary(backup);
    const stored = backup.items.get(LIBRARY_ID);
    assert.equal(stored, Buffer.from(stored ?? '', 'base64').toString('base64'));
    assert.equal(Buffer.from(stored ?? '', 'base64').length, 32);
    KeyStore.open({ safeStorage, dataDir, masterBackup: backup });
    assert.equal(backup.writes, 2);
    assert.equal(backup.items.get(LIBRARY_ID), stored);
  });

  test('an open without a library id does not write an item', () => {
    const backup = new FakeBackup();
    const dataDir = tempDir();
    KeyStore.open({ safeStorage: fakeSafeStorage(0x5a), dataDir, masterBackup: backup });
    assert.equal(backup.writes, 0);
  });

  test('a backup write failure still opens the library', () => {
    const backup = new FakeBackup();
    backup.failWrite = true;
    const dataDir = tempDir();
    writeLibraryId(dataDir, LIBRARY_ID);
    const store = KeyStore.open({ safeStorage: fakeSafeStorage(0x5a), dataDir, masterBackup: backup });
    assert.equal(store.currentKey().id, 1);
    assert.equal(backup.items.has(LIBRARY_ID), false);
  });

  test('openWithMaster does not write the item while the file is still the app-lock record', () => {
    const backup = new FakeBackup();
    const { dataDir, safeStorage } = openedLibrary(backup);
    const master = Buffer.from(backup.items.get(LIBRARY_ID) ?? '', 'base64');
    writeFileSync(join(dataDir, 'master.key'), Buffer.from('OVLK-record'));
    const writes = backup.writes;
    KeyStore.openWithMaster({ safeStorage, dataDir, masterBackup: backup }, master);
    assert.equal(backup.writes, writes);
    master.fill(0);
  });

  test('an OVLK file and an unavailable secret store do not read the item', () => {
    const backup = new FakeBackup();
    const locked = tempDir();
    writeLibraryId(locked, LIBRARY_ID);
    writeFileSync(join(locked, 'master.key'), Buffer.from('OVLK-record'));
    assert.equal(probeLibraryCustody(fakeSafeStorage(0x5a, false), locked, backup), 'ok');
    const sealed = tempDir();
    writeLibraryId(sealed, LIBRARY_ID);
    writeFileSync(join(sealed, 'master.key'), Buffer.from('sealed'));
    assert.equal(probeLibraryCustody(fakeSafeStorage(0x5a, false), sealed, backup), 'keychain-unavailable');
    assert.equal(backup.reads, 0);
  });

  test('a vouched item replaces an unreadable master.key and the probe is ok', () => {
    const backup = new FakeBackup();
    const { dataDir } = openedLibrary(backup);
    const before = readFileSync(join(dataDir, 'master.key'));
    writeFileSync(join(dataDir, 'master.key'), Buffer.from('foreign-password'));
    assert.equal(probeLibraryCustody(throwingSafeStorage(0x5b), dataDir, backup), 'ok');
    const after = readFileSync(join(dataDir, 'master.key'));
    assert.notDeepEqual(after, Buffer.from('foreign-password'));
    assert.equal(probeMasterUnwrap(fakeSafeStorage(0x5b), dataDir), 'ok');
    assert.notDeepEqual(before, after);
  });

  test('a decryptable master that keys.json rejects does not replace the stored copy', () => {
    const backup = new FakeBackup();
    const { dataDir, safeStorage } = openedLibrary(backup);
    const stored = backup.items.get(LIBRARY_ID);
    const writes = backup.writes;
    writeFileSync(join(dataDir, 'master.key'), safeStorage.encryptString(randomBytes(32).toString('base64')));
    assert.throws(() => KeyStore.open({ safeStorage, dataDir, masterBackup: backup }));
    assert.equal(backup.writes, writes);
    assert.equal(backup.items.get(LIBRARY_ID), stored);
  });

  test('a staging open does not write the item', () => {
    const backup = new FakeBackup();
    const dataDir = tempDir();
    writeLibraryId(dataDir, LIBRARY_ID);
    KeyStore.open({ safeStorage: fakeSafeStorage(0x5a), dataDir, masterBackup: backup, recordMasterBackup: false });
    assert.equal(backup.writes, 0);
  });

  test('an absent item, a denial, a bad value, or a master keys.json will not vouch for leaves the file untouched', () => {
    const cases: Array<{ name: string; prepare: (backup: FakeBackup, dataDir: string) => void; state: string }> = [
      { name: 'absent', prepare: (backup) => backup.items.delete(LIBRARY_ID), state: 'unwrap-failed' },
      {
        name: 'denied',
        prepare: (backup) => {
          backup.readError = new LibraryMasterBackupError('denied');
        },
        state: 'unwrap-failed',
      },
      {
        name: 'short',
        prepare: (backup) => backup.items.set(LIBRARY_ID, Buffer.alloc(16, 1).toString('base64')),
        state: 'malformed',
      },
      {
        name: 'loose',
        prepare: (backup) => {
          const canonical = backup.items.get(LIBRARY_ID) ?? '';
          backup.items.set(LIBRARY_ID, ` ${canonical}`);
        },
        state: 'malformed',
      },
      {
        name: 'row',
        prepare: (_backup, dataDir) => {
          const keys = JSON.parse(readFileSync(join(dataDir, 'keys.json'), 'utf8')) as { keys: Array<{ wrappedKey: string }> };
          const row = keys.keys[0];
          assert.ok(row !== undefined);
          row.wrappedKey = `${row.wrappedKey.slice(0, -1)}${row.wrappedKey.endsWith('A') ? 'B' : 'A'}`;
          writeFileSync(join(dataDir, 'keys.json'), JSON.stringify(keys));
        },
        state: 'unwrap-failed',
      },
      {
        name: 'empty',
        prepare: (_backup, dataDir) => writeFileSync(join(dataDir, 'keys.json'), JSON.stringify({ version: 1, keys: [] })),
        state: 'unwrap-failed',
      },
      {
        name: 'missing',
        prepare: (_backup, dataDir) => rmSync(join(dataDir, 'keys.json')),
        state: 'unwrap-failed',
      },
    ];
    for (const candidate of cases) {
      const backup = new FakeBackup();
      const { dataDir } = openedLibrary(backup);
      candidate.prepare(backup, dataDir);
      writeFileSync(join(dataDir, 'master.key'), Buffer.from(`foreign-${candidate.name}`));
      const before = readFileSync(join(dataDir, 'master.key'));
      assert.equal(probeLibraryCustody(throwingSafeStorage(0x5b), dataDir, backup), candidate.state, candidate.name);
      assert.deepEqual(readFileSync(join(dataDir, 'master.key')), before, candidate.name);
    }
  });

  test('registry removal does not delete the item', () => {
    const source = readFileSync(join(process.cwd(), 'src/main/library/library-registry-runtime.ts'), 'utf8');
    const start = source.indexOf('removeEntry(id: string, openId: string | null');
    assert.notEqual(start, -1);
    const end = source.lastIndexOf('}');
    const body = source.slice(start, end);
    assert.match(body, /getRegistry\(\)\.remove\(id\)/u);
    assert.equal(body.includes('masterBackup'), false);
    assert.equal(body.includes('LibraryMaster'), false);
  });

  test('the native bridge stores the master as keychain data for the signed app only', () => {
    const source = readFileSync(join(process.cwd(), 'native/touch-id/library_master.mm'), 'utf8');
    const loader = readFileSync(join(process.cwd(), 'native/touch-id/library-master.cjs'), 'utf8');
    assert.equal(OVERLOOK_LIBRARY_MASTER_SERVICE, 'com.zts1.overlook.library-master');
    assert.ok(source.includes(OVERLOOK_LIBRARY_MASTER_SERVICE));
    for (const contract of [
      'kSecAttrSynchronizable',
      'kSecUseDataProtectionKeychain',
      'interactionNotAllowed',
      'SecTrustedApplicationCreateFromPath',
      'SecAccessCreate',
      'kSecValueData',
      'kSecAttrAccess',
    ]) {
      assert.ok(source.includes(contract), contract);
    }
    assert.match(source, /kSecAttrSynchronizable : @NO/u);
    assert.match(source, /kSecUseDataProtectionKeychain : @NO/u);
    assert.doesNotMatch(source, /add-generic-password/u);
    assert.doesNotMatch(source, /kSecAccessControlBiometryCurrentSet/u);
    assert.doesNotMatch(source, /SecItemUpdate/u);
    assert.match(source, /SecItemDelete/u);
    const restore = readFileSync(join(process.cwd(), 'src/main/backup/restore-engine.ts'), 'utf8');
    assert.match(restore, /recordMasterBackup: false/u);
    assert.ok(restore.lastIndexOf('rememberOpenedMaster') > restore.indexOf('await activateStagedLibrary'));
    const created = readFileSync(join(process.cwd(), 'src/main/library/library-registry-runtime.ts'), 'utf8');
    const createBody = created.slice(created.indexOf('create(options:'), created.indexOf('addExisting('));
    assert.match(createBody, /discardCreatedLibrary\(dir, id\)/u);
    assert.match(loader, /library-master\.node\.napi/u);
  });

  test('non-macOS has no item and a missing darwin addon fails closed', () => {
    const linux = createLibraryMasterBackup({ platform: 'linux' });
    linux.write('not-a-ulid', 'value');
    assert.equal(linux.read(LIBRARY_ID), null);
    linux.remove(LIBRARY_ID);
    const missing = createLibraryMasterBackup({
      platform: 'darwin',
      loadBinding: () => {
        throw new Error('missing');
      },
    });
    assert.throws(() => missing.remove(LIBRARY_ID), LibraryMasterBackupError);
    const bindingItems = new Map<string, Buffer>();
    const darwin = createLibraryMasterBackup({
      platform: 'darwin',
      loadBinding: () => ({
        write: (_service: string, account: string, secret: Buffer) => {
          bindingItems.set(account, Buffer.from(secret));
          return { status: 'stored' };
        },
        read: (_service: string, account: string) => {
          const data = bindingItems.get(account);
          return data === undefined ? { status: 'absent' } : { status: 'value', data };
        },
        remove: (_service: string, account: string) => {
          bindingItems.delete(account);
          return { status: 'stored' };
        },
      }),
    });
    const secret = randomBytes(32).toString('base64');
    darwin.write(LIBRARY_ID, secret);
    assert.equal(darwin.read(LIBRARY_ID), secret);
    assert.throws(() => darwin.write('library-a', secret), LibraryMasterBackupError);
    darwin.remove(LIBRARY_ID);
    assert.equal(darwin.read(LIBRARY_ID), null);
  });
});
