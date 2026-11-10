# Testing Strategy

> Canonical reference for how Overlook is tested: the lanes, what runs when and
> where, and the policy for adding coverage when features land. Lives in
> `docs/`, versioned with the code it describes.

## TL;DR

- **Local "before done" gate:** `npm run ci` = lint suite + `format:check` +
  `test:cov` (unit + renderer DOM) + `build` — the same non-browser gates CI
  runs.
- **CI follows PR lifecycle:** drafts run locally; ready heads, merge candidates,
  and manual preflights run the complete suite; validated main commits run a
  short integration smoke, with a complete-suite fallback. Ready/queue/manual
  suites also run unit, DOM, and a real import on Windows x64; main runs the
  source import on native Windows x64 and ARM64.
- **Floors ratchet upward only:** c8 lines 90 / branches 80 (`.c8rc.json`),
  type-coverage 99.8 strict, file-size budget 800 lines. The **a11y violation
  budget** (`tests/a11y/violation-budget.json`, #398) is the same policy
  inverted — its counts only ever **shrink**.
- **Policy:** coverage travels with the change — a new or changed user-facing
  flow lands with tests at the cheapest lane that proves the behavior.

## The lanes

| #   | Lane          | Command                                                                                                                                        | Scope                                                                                                                                                                                                                   | Status                                                                                       |
| --- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 1   | Static        | `npm run lint` (pins → new-file size → eslint → cycles → dead code → type coverage), `typecheck`, `format:check`                               | Pins, size budgets, correctness (incl. react-hooks + @eslint-react for the renderer and the process-boundary import matrix), ts+tsx cycles, dead code, all configured TypeScript projects, style (ts/tsx/html included) | Active                                                                                       |
| 2   | Unit          | `npm run test:compile && npm run test:unit:run` — compiled `.test-dist/tests/**/*.test.js`                                                     | Pure logic, no DOM                                                                                                                                                                                                      | Active                                                                                       |
| 3   | Coverage      | `npm run test:cov` — c8 floors in `.c8rc.json` (**lines 90 / branches 80**)                                                                    | Ratchet over the unit and renderer DOM lanes                                                                                                                                                                            | Active                                                                                       |
| 4   | DOM           | `npm run test:dom` — renderer-scoped compile, happy-dom registrator, CSS hook, then `node --test`                                              | Rendering/controllers against a DOM implementation (`tests/dom/`)                                                                                                                                                       | Active (#135)                                                                                |
| 5   | Story         | `npm run test:stories:ci` — static Storybook build + test-runner (`play` assertions, chromium)                                                 | Component-level UI behavior on the real token canvas                                                                                                                                                                    | Active (#56 — token + Icon stories are the first content)                                    |
| 6a  | E2E smoke     | `npm run test:e2e` — Playwright `_electron` launches the built app (`tests/e2e/smoke.spec.ts`)                                                 | The real Electron app launches, renders the React root, exposes only the typed bridge, IPC round-trips                                                                                                                  | Active (#52 — replaced the http-server fixture, which stayed green regardless of app health) |
| 6b  | Acceptance    | Playwright specs per canonical flow + a coverage-map ledger                                                                                    | End-to-end user flows                                                                                                                                                                                                   | **Deferred** until user-facing surfaces exist                                                |
| 7   | Accessibility | `check:a11y-budget` (static, in `npm run ci`) + axe in `test:stories:ci` (per story) and `test:e2e` (`tests/e2e/a11y.spec.ts`, composed flows) | WCAG 2.2 AA violations against a shrink-only budget                                                                                                                                                                     | Active (#398 — baseline 103)                                                                 |

### Every lane runs, every run

`npm test` and `npm run test:cov` dispatch the unit, renderer DOM, and
guard-conformance lanes through `scripts/run-test-lanes.mjs`: all three run to
completion and the runner fails once at the end, naming every failed lane. It
replaced an `&&` chain that let the first red lane skip the rest — which under
c8 also moved the numbers, since the DOM lane is what covers the renderer files
`.c8rc.json` admits, and a lane that never runs reports them at 0% (PR #995: a
single broken test file read as a coverage-floor breach for ten runs while three
real DOM failures sat in the skipped lane). A lane killed by a signal — the
guard's `rss-limit` kill, a timeout, the kernel OOM killer, Ctrl-C — still stops
the run; the lanes after it are reported as not-run, never as passed. That holds
even when a compound lane script's shell outlives its killed child and reports
the death as exit 128+N instead of a signal.

### Compile-then-run model

Unit tests run against compiled JS: `tsconfig.test.json` emits unit-testable
sources (`src/shared/` + `tests/`, `jsx: react-jsx` ready for future `.tsx`)
to `.test-dist/`, then `node --test` runs the output — no loader magic.
**The unit runtime is Electron's own Node** (`ELECTRON_RUN_AS_NODE=1 electron
--test`, #72): native modules in `node_modules` must load in the same runtime as
the app. Encrypted SQLite v13 uses bundled Node-API prebuilds across supported
Electron majors. The shipped native set is now entirely Node-API or loadable
extensions, so electron-builder's ABI rebuild is disabled; adding an ABI-bound
module requires restoring a selective rebuild strategy. Plain `node` is not the
native-runtime proof. E2E builds the app once in
`tests/e2e/global-setup.ts` (concurrent builds would clobber each other's
output).

### Electron multi-process gate coverage (#51)

The Electron layout (`src/main` / `src/preload` / `src/renderer` /
`src/shared`, ADR-0003) is fully inside the static gates: per-process strict
tsconfigs (`npm run typecheck` runs all four projects), type-aware ESLint with
react-hooks + `@eslint-react` on the renderer, `no-restricted-imports`
enforcing the process-boundary matrix (CLAUDE.md §Architecture), madge over
`ts,tsx`, knip via its electron-vite plugin, per-project `type-coverage`.

**c8 scope:** `src/main/` and `src/shared/` remain floored by the unit lane.
Renderer components join the same global floor when they receive DOM-lane
coverage; `.c8rc.json` lists the admitted renderer files explicitly so adding
an untested surface cannot silently lower the project floor. `src/preload/`
and unlisted renderer process wiring are exercised by Playwright-Electron
instead. Floor values are unchanged (ratchet intact).

### Renderer DOM lane (#135)

- `tests/dom/tsconfig.json` extends the renderer project (`Bundler`, DOM libs,
  `vite/client`) and emits tests plus imported renderer modules to
  `.test-dist-dom/`.
- `tests/dom/register.ts` runs through `node --import`, installs happy-dom, and
  registers the CSS-module hook before test discovery. Tests import the actual
  renderer components; they do not replace CSS or the component with a test
  double.
- `npm run test:dom` is the focused compile-and-run command. `npm test` and
  `npm run test:cov` compile and run both the Node unit lane and this DOM lane.

### Playwright-Electron caveats (#52)

- `_electron` is marked **experimental** by Playwright — pin-bumps of
  `@playwright/test` (Dependabot) can move it; a red E2E lane after a
  Playwright bump should suspect the API first.
- Each test launches its own app instance from `out/` (hermetic, ~1s cost);
  global-setup builds once. `electron.launch({ args: ['.'] })` resolves the
  Electron binary from `node_modules` and the entry from `package.json#main`.
- Local macOS Electron windows are hidden by default so the suite does not take
  keyboard focus. This is a real rendered `BrowserWindow` with background
  throttling disabled, not Chromium headless mode. Linux keeps the window
  visible inside Xvfb because hidden Chromium windows can report zero layout
  geometry. Native attention requests such as `second-instance`, `open-file`,
  and Dock activation still deliver their application events in the hidden
  harness, but must not restore, show, or focus its window. This focus-safety
  invariant is covered at the policy boundary and in the external-open E2E
  flows. Use
  `npm run test:e2e:visible` for native-window debugging; a lifecycle-dependent
  spec can set `OVERLOOK_E2E_WINDOW=visible` in its launch environment.
  The performance lane always uses a visible native window so its frame and
  scroll budgets remain representative. Packaged builds ignore the harness flag.
- On CI (ubuntu) Electron needs OS libraries (`npx playwright install-deps`)
  and a display server — the E2E step runs under `xvfb-run`. No browser
  download: Electron carries its own Chromium.
- The `webServer`/`baseURL` fixture mechanism is gone; there is no port to
  collide on, so parallel workers stay safe.
- **Launch/readiness/teardown go through the shared `launchOverlook` fixture**
  (`tests/e2e/support/app.ts`): staged, individually-bounded launch readiness
  with stage-labeled stalls, and a bounded force-kill-backed close so a
  timed-out test cannot escalate into an unowned worker-teardown timeout.
  In-place reloads use `expectRendererReload`. Every wall-clock wait in the
  suite is inventoried and classified in the
  [E2E & Storybook Timing Audit](./E2E-Timing-Audit.md) (#630); add new timing
  waits there in the same PR. A timeout increase requires naming the stalled
  condition — never a blanket raise.
- The CI E2E command is wrapped by `scripts/measure-runner-capacity.mjs`, which
  samples normalized host load, available memory, and Linux CPU/I/O pressure
  while the guarded test entrypoint runs. Manual CI dispatches can compare one,
  two, and three workers with retries disabled; each run retains a
  `runner-capacity-*` evidence artifact. The ordinary required lane remains at
  three workers and two retries unless same-SHA measurements justify a change.

## What runs when & where

### Local — the "before done" gate

```sh
npm run ci        # lint suite, format:check, test:cov, build
npm run test:dom  # focused renderer DOM compile + tests
npm run test:e2e  # additionally, for E2E-relevant changes
npm run test:e2e:visible -- tests/e2e/example.spec.ts  # brief visible debug run
```

The pre-commit hook (husky + lint-staged) auto-fixes staged files
(`eslint --fix` + prettier). The pre-push hook then runs `npm run lint` and
`npm run format:check`, including both 800-line file-size tripwires. Do not use
`--no-verify` to bypass either hook. The remaining non-browser gates still run
through `npm run ci` locally and in hosted CI.

### CI — `.github/workflows/ci.yml`

- Draft PRs create no runner jobs; agents run every applicable local gate.
- Manual dispatch runs the complete suite for the dispatched ref's exact SHA.
- A ready PR reuses a successful manual suite only for its exact current head;
  otherwise lint, formatting, changesets, acceptance/a11y, tests with coverage,
  build, Storybook, E2E, docs-gov, Advanced CodeQL, and Windows x64 unit/DOM plus
  real copy-import validation all run.
- Each `merge_group` candidate runs that same complete suite. PR-scoped
  concurrency cancels obsolete ready runs without canceling other candidates.
- A `main` push with successful exact merge-group evidence runs the short interop
  smoke and default-branch CodeQL. Every main push also runs the source copy-import
  smoke on native Windows x64 and ARM64. Missing evidence triggers the complete
  Ubuntu suite.
- Stable `CI` evaluates the selected lane. `E2E gate`, docs-gov, and CodeQL keep
  their existing check identities and evidence artifacts.

The Playwright HTML report (traces, screenshots, videos) ships **only** as the
run's `playwright-report` artifact — download, unzip,
`npx playwright show-report <dir>`. The former Pages mirror depended on a
GitHub-managed build and deployment outside the governed lifecycle; retaining
only the run artifact avoids creating a GitHub-owned publishing exception or
handing a repo-scoped credential to a third-party publishing action.

There is no scheduled/nightly run. Manual dispatch is reserved for exact-SHA
preflight, diagnostics, release recovery, workflow testing, and explicit reruns;
the operational package and perf workflows remain manual.

### Packaging lane (manual, #53)

`npm run package` (electron-builder, unsigned: mac dmg+zip, win nsis) is
deliberately **not** in the PR gate — it is the slow lane. The **Package**
workflow (`workflow_dispatch`) builds unsigned mac + win artifacts on demand;
run it when packaging risk changes (Electron bumps, native modules, builder
config). After packaging, matching native x64 and ARM64 runners install each NSIS
artifact, import a checked-in fixture through the production copy path, verify
encrypted custody and source preservation, and uninstall in cleanup. Native
execution downloads the artifact's exact Electron version for the runner
architecture from Electron's official release and verifies its published SHA-256
before explicitly loading the installed `app.asar` and its adjacent unpacked
native modules. A path-bound harness contract admits only a real archive plus
the isolated smoke arguments. This keeps the smoke
packaged-only while avoiding GitHub's non-interactive service-session stall in
the signed desktop executable bootstrap. Historical refs without the packaged
smoke contract publish an explicit unsupported capability and skip this newer
gate, preserving release recovery. Native
modules stay in `dependencies`; the reviewed install step lays
down Node-API prebuilds, SQLite's inferred `binding.gyp` install is explicitly
denied, and `npmRebuild: false` prevents electron-rebuild from mistaking that
retained source metadata for an ABI-bound dependency. The after-pack hook
removes every foreign onnxruntime and SQLite prebuild before architecture
verification (ADR-0006, #683, #1020). Signing/notarization is M11.

### Perf baselines (manual, #74)

Recorded baselines live next to the lane that produces them; re-record when
the machinery they measure changes.

| Baseline         | How                                                                                                                                           | Result (2026-07-12, Apple Silicon dev machine)                          |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 200K keyset page | unit lane prints `[baseline] 200K keyset page`                                                                                                | 0.4 ms                                                                  |
| 200K grid scroll | `npm run seed:perf` boots a 200,000-row synthetic profile; the grid's frame monitor exposes `globalThis.__overlookFrameStats` while scrolling | 557 frames observed, 0 dropped (>25 ms), worst 9.4 ms; 36 cells mounted |

The inclusion-rule baseline (#1099) lives in
`tests/db/inclusion-page-performance.bench.ts`, run sequentially after the unit
and DOM lanes by both `npm test` and coverage. Its `.bench` suffix excludes it
from the parallel unit glob. Settled sync-ledger rows accompany every photo,
matching the production join footprint. It seeds
200,000 rows: 20,000 below 4 MP and a disjoint 10,000 with preview failures.
Each policy walks every 200-row page through `PhotosRepository.page`, checks
unique IDs and exact membership, and records p50, p95, and maximum latency.
Timing excludes seeding and assertions but includes row hydration; it includes
the terminal empty page. This mixed dataset supersedes the old homogeneous
first-page fixture; the historical 0.4 ms result above is not a full-walk baseline.

Review corrected the fixture's missing ledger rows and isolated it from the
parallel unit suite. Earlier empty-ledger timings are superseded and are not
calibration evidence. The original cold first-page 250 ms ceiling remains.
The full-walk gate uses p95 rather than the maximum of thousands of samples;
max remains diagnostic output.

Corrected local measurement, 2026-09-22, macOS Apple Silicon, Node 24.18.0,
via `npm test` (settled ledger rows; isolated benchmark lane):

| Policy           |    Rows |      p50 |      p95 |  Maximum |
| ---------------- | ------: | -------: | -------: | -------: |
| Unfiltered       | 200,000 | 33.26 ms | 71.25 ms | 77.19 ms |
| Hide unavailable | 190,000 | 35.65 ms | 77.50 ms | 82.57 ms |
| Minimum 4 MP     | 180,000 | 37.18 ms | 79.30 ms | 90.47 ms |
| Both rules       | 170,000 | 39.76 ms | 83.15 ms | 90.13 ms |

The corrected cold first page was 1.4 ms. Hosted calibration at
`85e275bfdd362498aa5db0604f7238c590a6dd03`, 2026-09-22:

| Platform / policy          |      p50 |       p95 |   Maximum |
| -------------------------- | -------: | --------: | --------: |
| Ubuntu / unfiltered        | 79.57 ms | 160.95 ms | 177.65 ms |
| Ubuntu / hide unavailable  | 84.82 ms | 159.49 ms | 176.32 ms |
| Ubuntu / minimum 4 MP      | 88.17 ms | 167.39 ms | 186.62 ms |
| Ubuntu / both rules        | 88.76 ms | 184.31 ms | 193.43 ms |
| Windows / unfiltered       | 59.29 ms | 131.35 ms | 317.31 ms |
| Windows / hide unavailable | 78.97 ms | 161.41 ms | 233.19 ms |
| Windows / minimum 4 MP     | 90.69 ms | 188.25 ms | 226.52 ms |
| Windows / both rules       | 97.74 ms | 187.26 ms | 239.64 ms |

Evidence: [Ubuntu complete suite](https://github.com/qwts/overlook/actions/runs/35708208092/job/106682240387)
and [Windows unit lane](https://github.com/qwts/overlook/actions/runs/35708208092/job/106682240400).
Cold first pages were 3.3 ms and 4.0 ms respectively. Both benchmark lanes
passed; that workflow's separate relocation E2E failure is tracked in #1128.

The ratchet is **250 ms p95 per policy**: twice the slowest corrected
local/hosted p95 (188.25 ms), capped at the existing 250 ms budget. It is
therefore stricter than twice that baseline. Tighten as measurements improve;
do not raise the ceiling to make a regression pass. The isolated Windows max
outlier illustrates why maximum latency is diagnostic rather than the
full-walk gate. Filtered latency does not justify a pixel-area schema/index
change from this evidence.

Cursor-seek regressions (#1257) check SQLCipher index searches and strict cursor
ordering across ties, null dates, and inclusion filters. Windows qualification
retains the 200K fixture and 250 ms p95 budget.

The E2E lane keeps a fast 2,000-row variant of the same path
(`tests/e2e/grid.spec.ts`) so windowing + cursor paging stay covered per-PR;
the 200K run is manual because seeding takes ~17 s.

### Collections tree performance (#1105)

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

### Fingerprint progress count cost (#1221)

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

### Perf budgets (#123 — RATCHETS: tighten, never loosen)

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

### Coverage-map distribution (#126 sweep, 2026-07-13)

The full design README screen/interaction inventory maps to 33 ledger
entries: **31 automated** (32 playwright-e2e, 13 storybook, 11 unit-dom
coverages), **1 manual-with-reason** (motion timings / hover fills /
disabled opacity — visual-only rules; the disabled PATTERN is exercised by
component stories), and **1 deferred-with-issue** for the design README's
"not yet designed" set: semantic search results UI (#224). Zero unmapped flows; the validator
enforces shape, path existence, and that deferred entries carry issues.

### Accessibility gates (#398 — RATCHET: shrink, never raise)

WCAG 2.2 AA is the bar (epic #381). Three gates, two of which need a browser:

| Gate                        | Where                                                  | What it catches                                                                                                                                                |
| --------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run check:a11y-budget` | `npm run ci` + the CI `ci` job                         | Budget shape, path existence, unowned debt, a raised number. No browser, so it fails fast. Also runs as `--visited` after the story lane for the orphan check. |
| `npm run lint:contrast`     | `npm run lint` inside `npm run ci`                     | Declared semantic token pairs: 4.5:1 normal text and 3:1 UI/status contrast, using the shared WCAG luminance module consumed by theme validation.              |
| axe per story               | `test:stories:ci` (existing chromium runner, +0 lanes) | Component-level violations across all 107 stories, scoped to `#storybook-root`.                                                                                |
| axe per composed flow       | `test:e2e` (`tests/e2e/a11y.spec.ts`)                  | What isolated stories structurally cannot show: landmark uniqueness, focus order across regions, an overlay leaving the shell in the a11y tree.                |

**The budget** (`tests/a11y/violation-budget.json`) is the honest list of KNOWN
violations, keyed by story id / flow id, each naming the issue that owns the fix.

- **Counts are keyed by axe rule id, never totalled.** A bare total is not a
  ratchet: a surface budgeted `1× color-contrast` could be "fixed" into
  `1× button-name` and still sum to 1, hiding a fresh regression behind existing
  debt. Verdicts compare rule-by-rule (PR #408 review).
- **Unlisted surfaces are budgeted at ZERO** — a new violation anywhere fails
  without anyone remembering to add an entry.
- **Under budget also fails.** An unrecorded improvement leaves a stale number that
  silently permits regression back up to it. The failure message names the value to
  set; drop a rule at zero, and delete the entry when its last rule goes.
- **Orphaned entries fail.** Both lanes record which ids they audited
  (`--visited` after `test:stories:ci`; a closure test in `a11y.spec.ts`), because
  path existence cannot catch a renamed story export — the file survives, so the
  static check passes while the runtime lane stops evaluating that id.
- Fix the violation or shrink the entry. **Never raise one, and never narrow the
  `tags`** — the tag set is pinned in the budget and re-checked by the validator.

**`axe-core` is pinned exact and overridden into `axe-playwright`'s floating
`^4.10.1`.** Its rule set _defines_ every count, so a Dependabot bump is _expected_
to move numbers: re-audit and re-baseline in that PR.

Reduced motion is centralized in the renderer motion tokens: under
`prefers-reduced-motion: reduce`, transitions and animations complete in 1 ms
and repeating animations run once. The nonzero duration preserves lifecycle
events used by dialog teardown. `tests/e2e/visual-accessibility.spec.ts` also
sets the real Electron page zoom to 200% and proves the shell, Settings, grid,
and Lightbox remain reachable without root-document horizontal scrolling. The
[manual visual-accessibility pass](./acceptance/Acceptance-Test-Visual-Accessibility.md)
covers physical OS settings and text-over-photo readability.

Re-baseline (this is how the audit was produced):

```sh
OVERLOOK_A11Y_REPORT=/tmp/a11y.jsonl npm run test:stories:ci   # JSONL, one line per story
```

The [July 2026 audit](./Accessibility-Audit-2026-07.md) records the baseline, the severity
ranking, the accepted exceptions, and — importantly — **what the automation cannot
see**. The [VoiceOver script](./acceptance/Manual-Test-A11y-VoiceOver.md) covers that half; axe detects
roughly a third of WCAG issues, so a green gate is not a claim of accessibility.

## Policy: coverage travels with the change

1. **Prefer the cheapest lane that proves the behavior.** Unit for logic; DOM
   for rendering; stories for component interaction;
   Playwright only for true end-to-end flows.
2. **Regression fixes ship with a failing-then-passing test** at the lane that
   would have caught the bug.
3. **Never lower a floor to pass.** c8 thresholds, type-coverage, and the
   file-size budget are ratchets: raise them as coverage improves, never lower
   them to merge.
4. **The acceptance coverage-map ledger is ACTIVE** (#82, per
   [ADR-0001](./adr/ADR-0001-Automation-Check-Governance.md)): every user-facing flow
   declares its coverage in `tests/e2e/coverage-map.json` — automated
   (`playwright-e2e` / `storybook` / `unit-dom` with paths), `manual` (with a
   reason), or `deferred` (with an issue). Two gates enforce it inside
   `npm run ci` and the CI job (`npm run check:acceptance-coverage`):
   `check-e2e-coverage-map.mjs` validates shape, path existence, and that
   every Playwright spec is mapped (deleting a mapped spec fails);
   `check-acceptance-coverage-diff.mjs` requires renderer `.ts/.tsx/.css`
   changes to touch the map — or carry a `no-acceptance-impact` token in the
   PR body/label when a change genuinely has no flow impact. The PR template
   carries the acceptance checkbox; the coverage-summary reporter renders the
   map distribution on each run. Each epic seeds its own entries.

## pCloud live contract run (owner-executed, never CI)

pCloud is enabled in standard release packages by the public OAuth client ID
stored in the `PCLOUD_CLIENT_ID` repository secret. The Package workflow maps
that value to `OVERLOOK_PCLOUD_CLIENT_ID` while bundling. Local and test builds
can set the same environment variable directly. A non-empty client ID exposes
the pCloud backup/restore adapter and its pCloud-only Transfer & Sync surfaces;
without one, the provider and its IPC/UI entries remain fail-closed.
`OVERLOOK_PCLOUD_ENABLED=0` is an explicit build-time kill switch, while `1`
can still opt in when exercising the legacy flag path. Disabling the feature
does not delete any previously sealed local authorization.

The provider contract suite also runs against **live pCloud** (#256, the
#109 epic) — env-gated so CI stays mock-only:

```sh
OVERLOOK_PCLOUD_CLIENT_ID=<public-client-id> \
  OVERLOOK_PCLOUD_LIVE=1 \
  npm run test:pcloud:live
```

The suite prints a pCloud authorize URL; open it in a browser and approve.
The loopback listener captures the token itself (implicit flow — nothing to
copy) and the contract cases run against a scratch prefix under
`/Overlook/contract-scratch-<ulid>/`, cleaned up afterward. Requirements: a
browser session logged into the owner's pCloud account, and the registered
redirect (`http://127.0.0.1:41573/callback`) reachable — i.e. run it on a
machine, not a headless box. A green run is #109's exit criteria; record it
on the epic when it passes.

## iCloud Drive signed live contract (owner-executed, never CI)

Normal CI uses the deterministic iCloud authority. Live validation requires
the exact macOS ZIP from a manually dispatched **Package** workflow because the
app must be Developer ID signed, notarized, and provisioned for the production
iCloud Documents container. On a Mac signed in to iCloud Drive, extract the ZIP
and run:

```sh
OVERLOOK_ICLOUD_ARTIFACT_COMMIT=<workflow-head-sha> \
  npm run test:icloud:live -- /path/to/Overlook.app
```

The guarded command verifies signing/provisioning before launching a
packaged-only contract mode. It writes redacted evidence under `test-results/`
and removes only its generated library ULIDs. Apple Account material must never
enter Actions, logs, evidence, or the repository. Follow
[iCloud Drive acceptance](./acceptance/Manual-Test-iCloud-Drive.md).

## Command quick reference

```sh
npm run ci              # full local gate (mirrors CI's non-browser jobs)
npm run test            # typecheck + compile + unit and renderer DOM tests
npm run test:cov        # same under c8 with the coverage floor
npm run test:dom        # focused renderer DOM compile + tests
npm run coverage:summary# render totals vs. floor
npm run test:e2e        # Playwright (builds app via global-setup)
npm run test:e2e:ui     # Playwright UI mode
```
