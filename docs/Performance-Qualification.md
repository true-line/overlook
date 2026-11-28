# Performance Qualification

Canonical performance fixtures, measurement boundaries, ratchets and retained
evidence. Run heavy qualification in hosted CI; local plan/unit regressions do
not establish 200K performance acceptance. #1221 remains open until an exact-head,
unprofiled complete run executes every required assertion successfully.

## Collections tree performance (#1105)

The manual performance lane also runs `tests/perf/collections-perf.spec.ts`:
300 collections (42 folders and 258 nonempty albums), depth six, 1,000 photos,
and 2,064 overlapping memberships over 200 distinct photos. Seeding is untimed
and uses the real IPC APIs. Five samples measure listing, actual sibling
reorders, and cross-folder moves; assertions verify membership and persisted
structure. Sidebar expansion measures a native DOM click through the next
painted frame with the complete subtree mounted, separately from IPC latency.

`test-results/collections-perf-report.json` records fixture dimensions, every
sample, and medians; the manual workflow uploads it alongside the existing
report. Hosted Ubuntu calibration at `0a782f27` in
[run 35715275613](https://github.com/qwts/overlook/actions/runs/35715275613)
passed this scenario in 57.9 seconds. Budgets are twice the slowest of five
samples, rounded up to 25 ms, and may only tighten:

| Metric                      |  Median | Slowest sample |   Budget |
| --------------------------- | ------: | -------------: | -------: |
| Collection listing over IPC | 59.9 ms |       128.1 ms | < 275 ms |
| Sibling reorder over IPC    |  8.3 ms |         8.9 ms |  < 25 ms |
| Cross-folder move over IPC  | 46.7 ms |        50.0 ms | < 100 ms |
| Complete subtree expansion  | 66.2 ms |        74.4 ms | < 150 ms |

The same run failed the separate 200K search assertion; its report also showed
semantic-search and import values outside their existing bounds, tracked in
[#1221](https://github.com/qwts/overlook/issues/1221). This collection baseline
is not evidence that the complete performance lane passed. Existing ratchets
are unchanged, and no local heavy-lane run is claimed.

## Fingerprint progress count cost (#1221)

The post-batching diagnostic [run 35771446566](https://github.com/qwts/overlook/actions/runs/35771446566)
at `c55de382` attributed about 17.77 seconds of a 30.26-second import capture to
full-library fingerprint status queries. Candidate batching alone did not bound
the progress-count scans, which ran after every 25 stored rows.

Background progress now requires both the row threshold and a minimum one-second
interval after the preceding count/notification finishes. Fast deferral bursts
therefore do not recount the whole library every 25 photos. Explicit `status()`
and review reads remain fresh, and every non-cancelled completed pass publishes
its final counts. No fingerprint write, per-photo yield, invalidation, or
cancellation rule changes. Deterministic clock tests cover burst coalescing,
elapsed progress, slow count callbacks, completion, and cancellation.

This bounds one measured source of work; it does not establish full performance
qualification. The unprofiled run 35770607316 still missed cold-start,
semantic-search, and import-throughput budgets. A fresh complete unprofiled run
is required after this change; all existing ratchets remain unchanged.

## Fingerprint candidate scan cost (#1221)

The current-main diagnostic [run 46097419079](https://github.com/true-line/overlook/actions/runs/46097419079)
at `2e001eca` attributed 12.589 seconds of its 28.994-second import capture to
fingerprint pending-candidate selection. The query scanned the wide photo table
and sorted it again for each 64-photo batch. Migration 51 adds a partial covering
index in the existing `(imported_at, id)` order, so the batch limit can stop the
index walk without a full-table sort. Freshness, protected-photo exclusion,
invalidation, cancellation, per-photo yielding and progress cadence are unchanged.

The upgrade regression compares candidates before/after migration, including
deferred, deleted and subsequently invalidated rows. It also requires a covering
query plan without a temporary sort. These are correctness/plan assertions, not
200K timing acceptance. Hosted unprofiled complete qualification must still
satisfy every existing ratchet and retain both report files before #1221 closes.

## Semantic eligibility reads (#1221)

The current-main query profile in [run 46097419079](https://github.com/true-line/overlook/actions/runs/46097419079)
sampled 6.406 seconds in scalar cosine retrieval and 1.938 seconds in embedding
status reads. After the fingerprint index, the unprofiled index-only
[run 46099967238](https://github.com/true-line/overlook/actions/runs/46099967238)
at `c356d406` passed cold-start, page, count and keyword assertions, then failed
the composed-search assertion at 1,246.6 ms. Import (5.0203 photos/s) and zoom-96
drops (0.1399) were within their ratchets by report comparison; those later
assertions were not executed.

Migration 52 covers live-photo identity, content freshness and visibility fields
so existing eligibility/count queries avoid the wide photo rows. Scalar cosine,
filtering before LIMIT, photo-ID tie order, model freshness and accurate public
counts are unchanged. The upgrade regression uses unequal vector magnitudes and
reverse insertion order, more ties than the limit, favorites, hidden/deleted rows
and stale content. The query-plan assertion requires a covering read; it does
not establish performance acceptance. All ratchets still require an unprofiled
complete run on the final head.

## Perf budgets (#123 — RATCHETS: tighten, never loosen)

The harness: `npm run test:perf` (own Playwright config, ~90 s;
never a per-PR gate) or the manual CI lane (`perf.yml`, `workflow_dispatch`).
It runs the 200K synthetic profile as a SETTLED library (synced ledger rows —
born-dirty scale rows poisoned pending counts and doomed backups; recorded),
measures the table below, writes `test-results/perf-report.json`, and asserts
the budgets in `tests/perf/budgets.ts` (the enforced copy of this table).
Cold start is measured on a RELAUNCH of the already-seeded profile — the
product case, not the one-time synthetic insert. The untimed seeding launch,
first window, and status-bar readiness share one 180-second setup deadline,
with the seed process closed on success or failure (#1221). This setup allowance
does not change any measured performance ratchet. Budgets are ratchets and are
never loosened to absorb variance; CI numbers are indicative, while the
recorded baselines are the dev machine's.

The keyword-search sample explicitly requests `searchMode: 'keyword'`; the
separate semantic sample uses `auto` fusion. Query measurements are archived
before import starts, so a later timeout preserves that evidence. For CPU
attribution, dispatch the manual workflow with `profile=true`: it profiles
the main process during those two query samples and separately during import,
uploading `perf-query-profile.cpuprofile` and `perf-import-profile.cpuprofile`.
Each capture is requested after 30 seconds or when its operation finishes,
whichever comes first, so an import that remains pending can still leave CPU
evidence. A busy main thread may delay the inspector response. Profiling does
not cancel or shorten the measured operation.
Profiling is off by default. Profiled runs remain subject to every assertion,
but their timings are diagnostic only and must not establish a baseline.

Scroll measurements run three visible native-BrowserWindow trials at every
zoom. The report retains each trial's frames, drops, drop rate, and worst frame;
the drop-rate budget gates the median trial and the worst-frame budget gates the
maximum across trials. An incomplete trial set fails closed. This reduces
single-run scheduler noise without hiding a repeated regression or relaxing a
budget.

| Metric                                         | Budget       | Baseline (2026-07-17, Apple Silicon dev machine, 200K) |
| ---------------------------------------------- | ------------ | ------------------------------------------------------ |
| Cold start → existing-library grid interactive | < 5,000 ms   | 3,267 ms                                               |
| `library:page` (500) median over IPC           | < 250 ms     | 5.4 ms                                                 |
| `library:counts` median over IPC               | < 500 ms     | 469.1 ms (#124: one FILTER-clause pass)                |
| Search page median over IPC (place substring)  | < 600 ms     | 28.5 ms                                                |
| Scroll dropped-frame share (zooms 96/160/320)  | < 0.30 each  | 0.2581 / 0.0050 / 0.0000 median                        |
| Scroll worst frame delta                       | < 500 ms     | 100.9 ms maximum                                       |
| Import throughput (100 files, full pipeline)   | > 3 photos/s | 4.20 photos/s                                          |
| Main-process RSS after the workout             | < 1,500 MB   | 524 MB                                                 |
| Renderer JS heap after the workout             | < 512 MB     | 20.7 MB                                                |
| CPU image embedding (4-image labeled fixture)  | > 5 photos/s | 127.59 photos/s (#391, Apple Silicon)                  |
| CPU text embedding median                      | < 40 ms      | 6.20 ms (#391, Apple Silicon)                          |

#124 outcomes: `counts()` rewritten as ONE FILTER-clause pass over the
ledger join (689 → 378 ms; ratchet tightened to 500 ms). Zoom-96 scroll
drops (~0.20, worst frame 68 ms) stay within the 0.30 budget; the obvious
lever — letting Chromium disk-cache decoded thumbs — is REJECTED on privacy
grounds (decrypted bytes never hit disk, ADR-0004), so further tightening
waits for an in-memory decode pool (recorded).

#432 removed a React rerender from every unavailable-thumbnail load failure.
That path dominates the metadata-only 200K profile at 96px: the final corrected
implementation passed at 0.2581 median while preserving the visible and
screen-reader `PREVIEW UNAVAILABLE` fallback, and successful previews retain no
stale fallback text. The three-trial measurement contract above records the
remaining variance instead of lowering the 0.30 ratchet.
