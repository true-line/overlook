# Agent Instructions

Read `CONTRIBUTING.md` and [`docs/Contributing.md`](docs/Contributing.md).
Keep this file as a map; depth belongs under [`docs/`](docs/README.md).

## Communication

- Be brief: minimum words, bullets over paragraphs, no preamble, recap, or filler.
- Fix the problem; no sycophancy, apologies, or narrating past mistakes unless
  required for the fix.
- Disagree plainly when mistaken; cite code or docs.
- Do not narrate unsolicited intent or process, announce next steps, or confess
  partial completion. The pre-edit checkpoints in **Before Changing Code** are
  exempt — deliver those once, then implement without ongoing narration.
- Status updates belong in issue comments during issue work, not in chat unless
  the user asked for progress.

## Before Changing Code

- **New issue work:** investigate and root-cause (or confirm scope), then share a
  concise working note covering the problem, cause or scope, intended changes,
  assumptions, and likely tradeoffs. This keeps the user oriented; it is not an
  approval gate. Proceed from the user's stated goal, and surface only decisions
  that would materially change scope or risk.
- **Shared issue context:** add the same working note to the issue (issue comment
  per the claim flow in `docs/Contributing.md`) so the user and other
  contributors can work from the same information.
- **During implementation:** post issue comments for each meaningful change
  slice: what changed and why.
- **Before editing:** state in one short line each: likely fix, why it may not
  work, confidence (low/medium/high), possible regressions. Then implement.

## Working Agreement

- **Open a PR early; a draft is optional, finishing it is not.** Draft is a
  starting state, never an ending state.
- **Take the PR out of draft the moment the work is complete.** As soon as
  `npm run ci` passes locally (plus `test:e2e` / `test:stories:ci` where they
  apply), run `gh pr ready <n>` without being asked. **A draft PR is reviewed by
  nobody — not the owner, not the Codex bot** — so a PR abandoned in draft is
  indistinguishable from work never done, and it hides the one signal the owner
  has that a slice is finished. Check
  `gh pr list --state open --json number,isDraft,title` before reporting
  completion. If something genuinely blocks ready-for-review, name the blocker on
  the PR and in your summary; silence reads as abandonment. **"Ready for review"
  is the definition of done** — "pushed" and "CI is green" are not.
- **Commit frequently.** Small, coherent commits per meaningful slice; push
  regularly. No end-of-session mega-commits.
- **Queue the merge yourself.** Right after `gh pr ready`, run
  `gh pr merge <n> --auto --merge`. The branch updater and strict checks keep the
  PR current; do not manually rebase or merge `main` into a merely-behind branch.
  Details are in
  [CI Identity And Tokens](docs/CI-Identity-And-Tokens.md) → Merge automation.
- **Drafts run no Actions jobs.** Run `npm run ci`, `test:e2e`, and
  `test:stories:ci` locally as applicable. After pushing the final SHA, an agent
  may dispatch CI for exact-SHA preflight and wait for success before `gh pr
ready`; otherwise the ready transition runs the complete suite.
- **Use the status footer only during an active validation/build run or while
  pairing on manual testing.** Omit it from routine turns. When it applies:
  - `Build:` result of the relevant gates (`npm run ci` pass/fail, or "not run"
    with the reason)
  - `Commit:` current branch + short SHA, noting any dirty state

## Architecture

Electron process layout ([ADR-0003](docs/adr/ADR-0003-Desktop-Stack.md)),
enforced with `no-restricted-imports` in `eslint.config.js`:

- `src/main/` — main process (lifecycle, windows, IPC handlers). May import
  `src/shared/`, never `src/renderer/`.
- `src/preload/` — contextBridge only; builds the typed `window.overlook`
  surface. May import `src/shared/`, never `src/main/`.
- `src/renderer/` — sandboxed React app. May import `src/shared/` (types + pure
  logic), never `src/main/` or `src/preload/`.
- `src/shared/` — pure, process-free modules (IPC contract registry in
  `shared/ipc/`, domain logic). Imports nothing process-specific.

All renderer↔main traffic goes through the zod-validated channel/event registry
in `src/shared/ipc/channels.ts` — never raw `ipcRenderer`.

`src/renderer/src/styles/tokens/*.css` (ported verbatim from
`design/handoff/tokens/`, the committed design handoff package) is the single
styling source of truth. **No magic values** in renderer styles: color, type,
spacing, radii, elevation, and motion always reference a token (`var(--…)`).
Machine data renders with `.mono-data`; prose sentences with `.prose-note`.

## Product Invariants

- All application commands project from the typed shared registry governed by
  [ADR-0024](docs/adr/ADR-0024-Shared-Command-Registry-And-Application-Menu.md).
  Native menus, shortcuts, context menus, toolbars, and Quick Actions may show
  different subsets, but must not duplicate command identity, labels, enablement
  policy, shortcuts, or execution paths.

## Branch And GitHub Hygiene

- Development is trunk-based: short-lived branches cut from latest `main`, merged
  back via PR. No separate integration branch.
- Check `git status` before changing anything; preserve unrelated user work.
- Open PRs with explicit closing references (`Closes #N`) when the PR completes
  an issue — the close-linked-issues workflow parses the merged PR body.
- Review/issue feedback gets a visible reply before the thread is resolved: what
  commit fixed it, why no action was needed, or what linked follow-up owns it.
  Never resolve threads silently.
- Identity, tokens, third-party-action blast radius, and conflict recovery:
  [CI Identity And Tokens](docs/CI-Identity-And-Tokens.md).

## Documentation

- Repo-first: long-lived docs, SOPs, ADRs, and agent pitfalls live in
  [`docs/`](docs/README.md) — ADRs in [`docs/adr/`](docs/adr/), acceptance and
  manual test plans in [`docs/acceptance/`](docs/acceptance/), user stories in
  [`docs/stories/`](docs/stories/). The
  [Repo Documentation Pointer Map](docs/Repo-Documentation-Pointer-Map.md) says
  which page is canonical for a given repo path. The GitHub wiki is retired; its
  pages are stubs kept only so existing links resolve
  ([ENG-0003](https://github.com/qwts/agent-sop/blob/main/docs/decisions/ENG-0003-repo-is-documentation-source-of-truth.md)).
- **ADR gate:** an issue labeled `adr` changes an architectural contract — do not
  start its implementation until the governing ADR in [`docs/adr/`](docs/adr/)
  reads `Status: Accepted` (precedent: ADR-0022 ↔ #483, ADR-0023 ↔ #534). The
  issue's "ADR gate" section names the cluster: clustered issues share one ADR,
  written at the number their tracking issue reserves, indexed, and linked from
  every clustered issue. Semantic changes after acceptance go through an ADR
  amendment first, code second.

## Validation

Run the cheap gates locally, one at a time:

```sh
npm run lint     # agent-context, pins, colors, tokens, contrast, eslint, cycles, dead, types, i18n, licenses
npm test         # typecheck, compile, Electron-hosted unit + happy-dom DOM
npm run docs:gov
```

Then push and let CI verify the heavy lanes — `test:cov`, `test:e2e`,
`test:stories:ci`, `test:perf`, `build` and the full `ci` chain. **CI is the
authoritative lane** — its workflows invoke the `:inner` entrypoints directly.
Running heavy lanes locally exhausted the owner's machine. Ask first.

- Two gates read an external checkout: `DOCS_GOV_TOOLING_ROOT` (a `true-line/trueline-agent-docs-gov`
  checkout at commit `67db7dc9c20bc29222fb605b7ff9432fd58a2a3f`) and `INTEROP_IMAGE_TRAIL_ROOT`.
- **Floors are ratchets — raise them as quality improves, never lower them to
  pass.** The a11y violation budget ratchets the other way: its counts only
  shrink, and coming in under budget fails until the entry is tightened.
- **A red check you can run locally gets run locally before the fix is pushed.**
  For CI-only lanes reason from the failing job's log, and say which lane a claim
  rests on — E2E under Xvfb can disagree with a local pass.
- **Never bypass the Husky pre-push hook with `--no-verify`.** It runs the exact
  `npm run lint` entrypoint the hosted lint job uses.
- **Never suppress an a11y rule bare** — every `eslint-disable` carries a reason
  or the issue that owns the debt.
- Do not report a build, or any lane, you did not run — "CI will verify" is an
  honest status; "passing" is not.

Gate-by-gate detail, ratchet values, the three a11y lanes, license policy,
dependency pins and overrides, packaging checks, and the release/signing flow:
[Validation And Release Gates](docs/Validation-And-Release-Gates.md). Why the heavy lanes belong to CI: [ENG-0138](https://github.com/qwts/agent-sop/blob/main/docs/decisions/ENG-0138-machine-scoped-agent-memory-budget.md).

## Memory Budget

- This machine has **one** memory budget, shared by every worktree, repo and
  agent session on it, and nothing wraps the test entrypoints to enforce it —
  the machine guard was removed in `e4bc20c6`. Run the targeted lane that proves
  your change and leave the heavy lanes to CI (see [Validation](#validation)).
- Per-lane RSS baselines: [`docs/agent-process-guard.md`](docs/agent-process-guard.md).

## Tooling

- Node is pinned in `.nvmrc`; select it (`nvm use`) before installing. CI reads
  the same file — bump it to move local and CI together.
- Install with `npm ci`; it also installs the husky pre-commit hook (lint-staged:
  `eslint --fix` + prettier on staged files).
- Invoke tools through `PATH` (or `npx`); never hardcode machine-specific paths.
- Local macOS `test:e2e` windows stay hidden and must never activate or take
  desktop focus, including through `second-instance`, `open-file`, or Dock
  activation. Route every native restore/show/focus path through
  `e2e-window-visibility.ts`; use `test:e2e:visible` only for deliberate manual
  debugging.

## Agent Primitives

The file that steers agents is this one. Harness adapters, commands, hooks,
and tool permissions live in each harness's user directory, not this repo
(qwts/qwts-agent-sop#89). `npm run lint:agent-context` enforces the length ratchet
and asserts no harness adapter returns; `tests/tooling/agent-primitives.test.ts`
locks that absence, because `.claude/settings.json` was once replaced wholesale
in-repo and a hook dropped silently.

Instruction changes that claim to improve agent behavior cite evidence against
the [Agent Golden Tasks](docs/Agent-Golden-Tasks.md) set. "It reads better" is
not evidence.
