# Agent memory budget — overlook baselines

The machine memory guard that once wrapped every test entrypoint
(`tools/agent-guard/`) was removed in `e4bc20c6`; nothing enforces a budget
locally now. These measurements are kept because they are still the evidence
for which lanes are heavy and why they belong to CI. The agent-facing rule is in
[`AGENTS.md`](../AGENTS.md) → **Memory Budget**.

## Measured per-lane RSS

These peaks show which lanes are heavy and how much a lane's cost varies run to
run.

- **`npm test`** (typecheck + compile + Electron-hosted unit + happy-dom DOM):
  peak 1845–2071 MB across 19 processes locally (macOS, Apple Silicon, Node
  24.18) over three runs.
- **`npm run test:cov`** (the same suite under `c8`): peak 1932 MB across 20
  processes locally; 1194–1198 MB across 13 processes on CI (Linux).
- **`npm run test:stories:ci`** (static Storybook build served over http, driven
  by Playwright chromium): **8067 MB** local peak on one run and **5660 MB** on
  another — a >2× spread across runs of the same lane, with the esbuild/webpack
  build step, not the interaction tests, as the heavy part. CI's first real run
  peaked at 3849 MB across 24 processes. This lane is the reason a single
  measured peak is not a safe ceiling.
- **`npm run test:e2e`** (Playwright driving real Electron instances,
  `workers: 3` on CI): CI peak 4183 MB across 24 processes. Never measured
  locally — the lane pops real Electron windows and is CI-only in practice.
- **`npm run test:perf`** (single worker, 200K-photo synthetic seed): still
  unmeasured, and not measurable from CI — `perf.yml` invokes `test:perf:inner`
  directly on a runner and records no peak. A baseline for this lane needs an
  owner-approved local run.

## macOS and Linux do not agree

`ps` reports meaningfully different aggregate RSS for the same lane on the two
platforms, with macOS consistently higher — `test:stories:ci` above is the
clearest case (8067 MB local vs 3849 MB on CI for the same work). So:

- A local (macOS) peak and a CI (Linux) peak for the same lane are not
  comparable, and a lane that fits comfortably in CI can still exhaust a local
  machine. CI passing is not evidence that a lane is safe to run locally.
- Read the numbers above with that gap in mind.

## Hard-killed E2E runs used to orphan Electron

Playwright starts every Electron app in its own process group and drives it
over a debugging socket, so nothing tied an app's lifetime to the worker that
launched it. When a run was hard-killed — an agent's command timeout, the OOM
killer, a memory guard's `SIGKILL` of its process group, a double Ctrl-C — each
live instance (main, zygotes, GPU, renderer and network processes) was
reparented to init and kept running forever. It sat outside the killed group
and outside the descendant tree, which is why the removed guard, which walked
the tree and its own process group, neither counted nor killed it. Repeated
killed runs stacked orphans until the machine ran out of memory.

Measured on Linux (4 cores, 16 GB, Xvfb, 2 workers, `SIGKILL` of the runner's
process group once both workers had an app up, no cleanup between runs):

| Killed runs | Orphaned Electron RSS before | After the owner watchdog |
| ----------- | ---------------------------- | ------------------------ |
| 1           | 1207 MB (11 processes)       | 0                        |
| 2           | 2346 MB (22 processes)       | 0                        |
| 3           | 3472 MB (33 processes)       | 0                        |

`src/main/e2e-owner-watchdog.ts` now makes an unpackaged `OVERLOOK_E2E=1`
launch exit within a second of its Playwright worker going away (reparented,
or the pid gone), including a worker that died mid-launch and an
`app.relaunch()` successor, which follows the original worker through
`OVERLOOK_E2E_OWNER_PID` and `OVERLOOK_E2E_OWNER_START`. The start time
(`/proc/<pid>/stat` on Linux, `ps -o lstart` on macOS) stops a successor from
mistaking a process that reused the worker's pid for the worker. Windows has no
cheap start-time source here, so a successor there relies on the pid alone.
Packaged builds and ordinary development launches are untouched.

An uninterrupted run was already flat: the full suite (150 tests, 2 workers)
peaked at 4144 MB aggregate RSS in its first minute and stayed between 2.0 and
3.7 GB to the end, with at most one live app per worker. Per-run cost scales
with the worker count, which locally is Playwright's default of half the
logical cores, not with run length.
