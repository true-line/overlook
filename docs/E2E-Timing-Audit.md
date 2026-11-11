# E2E & Storybook Timing Audit

Checked-in inventory of every wall-clock wait in the Playwright-Electron E2E
suite and the Storybook interaction lane, with the synchronization contract
each one depends on. Written for [#630](https://github.com/true-line/overlook/issues/630)
(deterministic E2E synchronization) and kept current when timing waits are
added or changed — a new `test.setTimeout`, assertion timeout, sleep, or
product-timer wait belongs in the matching table below in the same PR.

The governing rule (issue non-goals): **a larger wall-clock budget cannot make
a missed event observable.** Increase a timeout only after identifying the
condition that stalled; classify every wait as one of four kinds and give it
the synchronization it actually needs.

## The four categories

1. **Product-time behavior** — the elapsed time _is_ the thing under test
   (toast auto-dismiss, chrome idle-autohide). The only correct wait is real
   or deterministically-advanced time. Candidates for a controllable clock.
2. **Readiness synchronization** — waiting for the app/renderer/layout to
   reach a state (launch ready, window reload complete, image decoded, layout
   settled). Must synchronize on a semantic signal, never a guessed duration.
3. **Operation completion** — waiting for background work to finish (import,
   backup, restore, offload, IPC round-trip). Synchronize on the app's own
   completion signal (status text, sync state, IPC resolution) under a bound
   sized to the work.
4. **Teardown** — app close and worker cleanup. Must be bounded so a stalled
   close cannot escalate into an unowned worker-teardown timeout.

## Shared fixture (categories 2 & 4)

`tests/e2e/support/app.ts` — `launchOverlook` runs the launch lifecycle through
named, individually-bounded stages (`electron-launch` → `first-window` →
`renderer-ready`); a stall reports **which** stage was missed plus window/
process state and a renderer console tail, instead of consuming the whole test
budget with a bare "Test timeout". Fixture teardown closes every launched
instance with a bounded, force-kill-backed `close` (category 4), so a
timed-out test can no longer leave `app.close()` hanging into Playwright's
30 s worker-teardown timeout — the failure mode that replaced the original red
with an unowned teardown error even when the retry passed.

Failure diagnostics retain separate bounded tails for all console output and
application messages (`[overlook]` and renderer errors). Platform noise cannot
evict the application tail. Active-library relocation logs engine failures before
reactivation reloads the renderer and can discard its IPC response (#1128).
The active relocation acceptance keeps its destination-path and photo-count
assertions: content access is fenced during teardown and copy so a renderer
request cannot reopen the source and recreate its ephemeral cache mid-scan.

`expectRendererReload` arms the `framenavigated` listener **before** triggering
an in-place reload (active-library move, app-lock relock), then requires the
renderer to re-reach its ready marker — replacing the raced
`firstWindow()` + bare `waitFor` that could observe the pre-reload document and
stall (the `library-relocation` 90 s failures on `main`). `appExited` bounds
the wait for a fault-injected process to die, with the exit signal captured at
launch so it is safe to await after the process is already gone.

Migrated onto the fixture: `library-relocation`, `albums`, `lightbox`,
`album-drag-drop`, `keyboard-navigation`, `offload-ui`. Those are the known failure classes
named by #630. Remaining hand-rolled launches are tracked as mechanical fixture
adoption; they do not use one-shot reload events and are outside the missed
lifecycle class this issue set out to close.

## Per-test budgets — `test.setTimeout` (category mix)

Each budget must be justified by the **sum of the bounded waits inside the
test**, not padded past a symptom. The 30 s config default
(`playwright.config.ts`) is correct only for tests whose bounded-wait sum fits
inside it; the tests below document why they exceed it.

| spec:line                                                                                                                | budget | dominant bounded waits                         | why > 30 s default                           |
| ------------------------------------------------------------------------------------------------------------------------ | ------ | ---------------------------------------------- | -------------------------------------------- |
| library-relocation:100                                                                                                   | 300 s  | 4 fault-inject launch+crash+relaunch cycles    | serial relaunch loop                         |
| protected-albums:235                                                                                                     | 180 s  | multi-launch relock/interrupt ceremony         | serial launches + scrypt                     |
| library-relocation:184                                                                                                   | 120 s  | multi-select move (copy+verify)                | copy/verify per library                      |
| keys-recovery:29                                                                                                         | 120 s  | 2 scrypt derivations + 3 launches              | real KDF cost                                |
| protected-albums:203                                                                                                     | 120 s  | protect ceremony (copy+encrypt+relock)         | crypto + relaunch                            |
| backup:73                                                                                                                | 120 s  | 504-photo seed boot + backup traffic           | large seed + `firstWindow({timeout:60_000})` |
| album-management (albums:63)                                                                                             | 120 s  | **3× backup completion @ 20 s** + long journey | bounded-wait sum structurally > 30 s         |
| album-drag-drop:129                                                                                                      | 90 s   | 80-row seed + many drag/drop + sync settle     | seed + serial DnD                            |
| jfif-lightbox:49                                                                                                         | 90 s   | large JFIF import + backup + full-res decode   | decode-bound                                 |
| library-relocation:73                                                                                                    | 90 s   | copy-mode move + **renderer reload**           | staged reload (`expectRendererReload`)       |
| library-relocation:154                                                                                                   | 90 s   | wizard probe → progress → results              | move pipeline                                |
| library-switcher-ui:28 / :150                                                                                            | 90 s   | switch/reinstall (multi-launch)                | serial launches                              |
| lightbox transform (lightbox:164)                                                                                        | 60 s   | 3 composed transform journeys, decode-gated    | bounded-wait sum > 30 s                      |
| albums:6                                                                                                                 | 60 s   | 2× backup completion @ 20 s                    | bounded-wait sum > 30 s                      |
| library-relocation:59 / :141                                                                                             | 60 s   | inactive move / refusal                        | staged launch + IPC                          |
| app-lock:35, trash:111, offload-ui:23, restore-cloud:82, library-switch:53/:141, backup:186, library-switcher-ui:74/:116 | 60 s   | relaunch or sync-transition cycles             | serial launches / background sync            |

The two entries called out in bold — `album-management` and `lightbox
transform` — are the tests that repeatedly hit the 30 s default **exactly**:
their bounded-wait sums always exceeded 30 s, so any CI contention pushed them
over. The budget bumps make the contract explicit; they are not blanket raises.

## Operation-completion waits — assertion timeouts (category 3)

Synchronize on the app's own completion signal under a bound sized to the work.

- **Import/encrypt** (`{timeout: 30_000}`): import-flow:80/163/254,
  export-flow:119/156/194/232, external-open:187, import-flow:144/220 (custody
  move). Signal: "N photos imported and encrypted" / custody-verification text.
- **Export/decrypt** (`{timeout: 20_000}`): export-flow:85/133/177/215. Signal:
  "N photos exported and decrypted".
- **Backup completion** (`{timeout: 20_000}`): backup:45/61/151/232,
  albums:26/138/166/184, trash:130/131, offload-ui:41. Signal: "ALL BACKED UP"
  / "BACKUP COMPLETE".
- **Key ceremony, scrypt-bound** (`{timeout: 30_000}`): keys-recovery:52/79/84,
  protected-albums:42/70/110/122/137/155/168.
- **Restore** (`{timeout: 30_000}` poll): restore-cloud:148 (`library.db`
  exists). **Large import ready** (`{timeout: 15_000}`): external-open:155.
- **Auto-backup sync** (`{timeout: 15_000}` poll): import-flow:112–117
  (`syncState` → all `'synced'`).
- **Layout settle after large seed** (`{timeout: 30_000}` decode /
  `{timeout: 15_000}` scrollHeight poll): backup:88/90–96.

`expect.poll` with the default 5 s bound (window count, menu state, settings
push, gesture/animation settle, image decode via `naturalWidth`) is used
throughout — acceptable because each polls a semantic predicate, not a clock.
The 200% zoom reachability checks in `visual-accessibility.spec.ts` poll the
strict target rectangle until every edge is inside the renderer viewport. This
synchronizes zoom-triggered layout and the Lightbox `ResizeObserver`: at narrow
container widths the initial toolbar placement is intentionally transient, but
the zero-edge accessibility bounds are never relaxed.

## Product-time behavior — real elapsed time (category 1)

These wait for a **product timer**; the elapsed time is the behavior under
test. The import-toast flow installs Playwright's renderer clock before the
toast is created and advances it explicitly. The remaining cases are documented
exceptions: Storybook `play` functions do not receive Playwright's page clock,
while lightbox/app-lock/a11y exercise composed Electron behavior across renderer
lifecycle or CSS-animation boundaries. They synchronize on semantic state.

| location                  | product timer                                              | current wait                                          |
| ------------------------- | ---------------------------------------------------------- | ----------------------------------------------------- |
| import-flow:95            | toast 4 s auto-dismiss (#411)                              | `page.clock.fastForward(4_200)` (deterministic)       |
| lightbox:304              | lightbox chrome idle-autohide                              | `toHaveAttribute('data-chrome','off',{timeout:5000})` |
| lightbox:293–309          | chrome wake/sleep on input                                 | attribute assertions around idle                      |
| app-lock:99/153           | unlock re-enable throttle                                  | `toBeVisible({timeout:3_000})`                        |
| app-lock:169/191          | 1 s failed-password backoff (Touch ID & password change)   | `page.waitForTimeout(1200)`                           |
| trash:246                 | 1 s failed-password backoff (Original deletion auth)       | `page.waitForTimeout(1_100)`                          |
| backup:351                | 1 s failed-password backoff (`restore.discover` auth gate) | `page.waitForTimeout(1200)`                           |
| a11y:157–166              | 120 ms bg transition settle                                | `.poll` running-animations == 0                       |
| Lightbox.stories:110      | 2.2 s chrome idle window                                   | `waitFor({timeout:4000})`                             |
| Toast.stories:121/147/161 | `autoDismissMs` 200/400 + hover/focus pause                | `setTimeout(400/600)` + `waitFor({timeout:2000})`     |
| ExportDialog.stories:18   | simulated export progress cadence                          | `setTimeout(40)` ×3                                   |

## Event-driven waits (not time-based)

Hand-rolled `new Promise` resolved by an event, not a timer — correct as-is,
listed for completeness: settings.spec:50 (`settings.onChanged` IPC push),
seeded-library:58/65 & app-lock:78 (`Image.onload/onerror` over
`overlook-thumb://`). The `app.process().once('exit')` waits in relocation and
library-switch are now the fixture's `appExited` helper.

## Harness bounds (outer envelope)

- CI invokes `test:e2e:inner` directly; the job's `timeout-minutes` is the
  operative whole-run bound. (The local `tools/agent-guard/` wrapper and its
  30-minute `--timeout-s` were removed in `e4bc20c6`.)
- `playwright.config.ts`: per-test `timeout: 30_000`, `expect.timeout: 5_000`,
  CI `workers: 1`, CI `retries: 0`, `fullyParallel: false` (spec files run
  concurrently, tests within a file serially).
- `global-setup.ts` builds the app once before workers start; `global-teardown.ts`
  sweeps the run-scoped temp-dir registry with a `retryDelay: 100`/`maxRetries: 3`
  tolerance for Electron releasing the userData lock just after `app.close()`.

## Runner capacity (category 4 scope §4 of #630)

`scripts/measure-runner-capacity.mjs` wraps the E2E CI entrypoint
(`test:e2e:inner`) and records elapsed time, logical/available CPUs, memory,
normalized load, and Linux CPU/I/O pressure samples. It is the only source of
these numbers for a CI run: the workflow does not route through the guard
wrapper, so no peak-RSS or process-count record is written on a runner. Manual `workflow_dispatch` inputs select one,
two, or three
workers and zero retries, producing a retained `runner-capacity-*` artifact for
each comparison. Ordinary required runs use one worker and zero retries.

Capacity verdicts compare artifacts from the same commit and runner image. A
normalized-load or pressure peak alone does not justify a larger runner: worker
count changes only when lower concurrency improves no-retry reliability enough
to outweigh wall time.

The closure comparison on commit `72631d5` used the same `ubuntu-latest` image
and disabled retries throughout. One worker passed all 86 tests in 4 min 51 s.
Two workers completed in 3 min 12 s but failed `offload-ui` once (82 passed,
3 skipped); the focused test then passed 20/20 guarded local repetitions. The
three-worker result and telemetry are linked from the issue's closing evidence.
Because the higher-concurrency miss did not reproduce locally, the required lane
chooses the stable one-worker baseline and removes retries instead of hiding a
miss. Retained JSON artifacts supply load, memory, and Linux CPU/I/O pressure;
the process guard supplies aggregate RSS and process count.

## Protected-album keyboard activation (#1173)

After closing Settings, the protected-album lifecycle spec waits for both dialog
removal and focus restoration to the Settings opener. Escape alone starts an
asynchronous exit; sending Enter to the sidebar before focus settles can reopen
Settings. The subsequent keyboard activation and password-input focus assertions
remain required, with no added sleep or expanded timeout.
