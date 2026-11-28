import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import Database from 'better-sqlite3-multiple-ciphers';

import { migrate } from '../../src/main/db/migrations.js';
import { PhotosRepository } from '../../src/main/db/photos-repository.js';
import { iteratePreviewRepairCandidates } from '../../src/main/import/preview-repair-candidates.js';
import { seedSynthetic } from '../../src/main/library/seed.js';

function world(t: TestContext) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  migrate(db);
  seedSynthetic(db, 1, 'preview-page', 129);
  const repo = new PhotosRepository(db);
  const read = repo.previewRepairCandidates.bind(repo);
  const limits: (number | undefined)[] = [];
  t.mock.method(repo, 'previewRepairCandidates', (...args: Parameters<PhotosRepository['previewRepairCandidates']>) => {
    const [hashes, ids, page] = args;
    limits.push(page?.limit);
    return read(hashes, ids, page);
  });
  return { db, repo, read, limits };
}

test('preview repair materializes lazy bounded pages in import order despite eligibility changes (#1221)', (t) => {
  const w = world(t);
  const expected = w.read();
  assert.equal(expected.length, 129);
  const iterator = iteratePreviewRepairCandidates(w.repo, new AbortController().signal);
  assert.deepEqual(w.limits, [], 'creating the pass must not materialize the library');
  const seen: string[] = [];
  for (let index = 0; index < 64; index += 1) {
    const next = iterator.next();
    assert.equal(next.done, false);
    assert.ok(next.value);
    seen.push(next.value.id);
  }
  assert.deepEqual(w.limits, [64]);
  w.repo.softDelete(seen);
  seen.push(...[...iterator].map(({ id }) => id));
  assert.deepEqual(
    seen,
    expected.map(({ id }) => id),
    'a shrinking candidate set must not cause OFFSET skips or duplicate tied dates',
  );
  assert.deepEqual(w.limits, [64, 64, 64]);
});

for (const stopAfter of [0, 1, 64]) {
  test(`preview repair aborts before another page after ${String(stopAfter)} rows (#1221)`, (t) => {
    const w = world(t);
    const controller = new AbortController();
    const iterator = iteratePreviewRepairCandidates(w.repo, controller.signal);
    for (let index = 0; index < stopAfter; index += 1) assert.equal(iterator.next().done, false);
    controller.abort();
    assert.equal(iterator.next().done, true);
    assert.deepEqual(w.limits, stopAfter === 0 ? [] : [64]);
  });
}

test('paged preview repair retains targeted photo/hash selection and validates page bounds (#1221)', (t) => {
  const w = world(t);
  const photos = w.read();
  const first = photos[0];
  const last = photos.at(-1);
  assert.ok(first && last);
  const signal = new AbortController().signal;
  assert.deepEqual(
    [...iteratePreviewRepairCandidates(w.repo, signal, undefined, [last.id, first.id])].map(({ id }) => id),
    [first.id, last.id],
  );
  assert.deepEqual(
    [...iteratePreviewRepairCandidates(w.repo, signal, [first.contentHash])].map(({ id }) => id),
    [first.id],
  );
  assert.deepEqual([...iteratePreviewRepairCandidates(w.repo, signal, undefined, [])], []);
  for (const limit of [0, -1, 1.5, Number.NaN]) assert.throws(() => w.read(undefined, undefined, { limit }), RangeError);
});
