import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

const ipc =
  readFileSync(join(process.cwd(), 'src/main/ipc.ts'), 'utf8') + readFileSync(join(process.cwd(), 'src/main/export/export-ipc.ts'), 'utf8');
const exportChannels = readFileSync(join(process.cwd(), 'src/shared/ipc/export-channels.ts'), 'utf8');
const channels = readFileSync(join(process.cwd(), 'src/shared/ipc/channels.ts'), 'utf8');

function section(source: string, start: string, end: string): string {
  return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
}

describe('filesystem export destination authority wiring (#992)', () => {
  test('every renderer-invokable filesystem export consumes the shared authority', () => {
    assert.match(ipc, /protectedAlbumExportRun[\s\S]*?destinationAuthority\.consume/u);
    assert.match(ipc, /exportRun\.name[\s\S]*?destinationAuthority\.consume/u);
    assert.match(ipc, /exportRunAll\.name[\s\S]*?destinationAuthority\.consume/u);
    assert.match(ipc, /exportRunBoard\.name[\s\S]*?destinationAuthority\.consume/u);
  });

  test('run contracts accept opaque grants instead of renderer destinations', () => {
    const selected = section(exportChannels, 'exportRun:', 'exportRunAll:');
    const protectedAlbum = section(channels, 'protectedAlbumExportRun:', 'protectedAlbumExportCancel:');
    assert.doesNotMatch(selected, /destination: z\.string/u);
    assert.doesNotMatch(protectedAlbum, /destination: z\.string/u);
    assert.match(selected, /authorization/u);
    assert.match(protectedAlbum, /authorization/u);
  });
});
