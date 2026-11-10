# Contributing to Overlook

This page is the canonical contributor and agent workflow guide. Read it
before starting tracked work, and update this page when workflow, documentation,
issue-claim, branch, PR, or validation rules change.

Overlook is built in small, issue-scoped slices. Canonical milestone, user-story,
ADR, and project notes live in `docs/`. Root-level repo markdown files are
stubs unless they are `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, or root
`README.md`.

## Before you open a PR

1. **Read the relevant issue** (and user story / milestone page once feature work
   begins). Scope your change to that issue's deliverables and exit criteria — do
   not pull forward work from a later issue unless the exit criteria require it.
2. **Don't reopen unresolved review feedback under a new PR.** If a PR is
   superseded, carry forward every open review comment into the new PR
   description and confirm each one is actually resolved in the diff.
3. **Run the full check locally before pushing:**

   ```sh
   npm run ci
   ```

   This mirrors CI's non-browser gates (lint suite, format check, tests with the
   coverage floor, build). For E2E-relevant changes also run `npm run test:e2e`.
   A PR whose description claims checks passed but that fails CI will be sent
   back without review. The Husky pre-push hook automatically reruns the exact
   `npm run lint` and `npm run format:check` entrypoints used by hosted CI; do
   not bypass it with `--no-verify`.

4. **Review documentation before merge.** If the PR changes behavior,
   architecture, testing strategy, automation checks, or CI expectations, update
   the relevant `docs/` page in the same unit of work. If a repo pointer exists,
   leave it as a stub and update the linked `docs/` page. If no doc update is
   needed, say why in the PR description.
5. **Write a manual test script for user-visible behavior.** When a PR changes
   behavior CI cannot fully exercise, include a short step-by-step manual test in
   the PR description with expected results for success and failure cases.

## PR scope control

- **One behavioral objective per PR.** Several files are fine only when they are
  required to complete the same objective.
- **Separate follow-up work into issues.** If review reveals a legitimate but
  non-blocking adjacent concern, create or link a GitHub issue instead of
  expanding the PR.
- **Keep review-fix commits focused.** No unrelated refactors while responding to
  review.
- **Stop and split when scope changes.** If a PR starts collecting unrelated
  fixes, pause, write down the remaining items, and open separate branches/PRs.
- **No silent ignored feedback.** Every review thread must end in one of three
  states before merge: fixed (commit named in a reply), deferred to a linked
  issue (with why), or rejected (with a short technical rationale). Post the
  reply on the thread, then mark it resolved. Do not resolve feedback without a
  visible explanation on the feedback itself.

## Agent operating rules

Automated coding agents follow the same hygiene as human contributors, plus:

- Start from a clean branch off `main` unless asked to continue an existing one.
  Development is trunk-based; there is no separate integration branch.
- Before implementing a GitHub issue, check for active claim signals: `[WIP]` in
  the title, an assignee, an in-progress label, an open linked PR, or a recent
  claim comment. Use those signals to coordinate visibly: describe the intended
  slice on the issue, avoid overwriting work in flight, and continue with
  independent or explicitly shared work when it is safe.
- Open a PR and link it to its issue with a closing reference (`Closes #N`) in
  the body. The merged-PR body is what the close-linked-issues automation parses.
  **Drafts are optional** — opening as a draft is welcome while work is in
  flight, and opening ready straight away is equally fine.
- **If you open a draft, take it out of draft the moment the work is complete.**
  Draft is a starting state, never an ending state. As soon as `npm run ci`
  passes, run `gh pr ready <n>` — do not wait to be asked. **A draft PR is
  reviewed by nobody — not the owner, not the Codex bot — so a PR abandoned in
  draft is the same as never doing the work**: from the outside it is
  indistinguishable from abandoned work. Never end a session with your own PR
  still in draft; check `gh pr list --state open --json number,isDraft,title`
  before reporting completion. If something truly blocks ready-for-review, say so
  on the PR and name the blocker — silence reads as abandonment. **"Ready for
  review" is the definition of done for a code slice**; "pushed" and "CI is
  green" are not.
- Verify before claiming success: run the same gates CI runs (`npm run ci`).
- Draft PR events start no Actions jobs. Before promotion, run the browser lanes
  locally when applicable; after the final push, an exact-SHA manual CI preflight
  may supply the complete-suite evidence reused by the ready transition.
- After pushing, wait for required checks; report failures factually.
- Record lessons and follow-ups in issues, PRs, or `docs/` — not only in chat.
- Keep user-facing summaries short and factual: what changed, what was tested,
  what remains.

## Branching and PR hygiene

- One PR = one issue / one behavioral slice. Don't bundle unrelated changes.
- PRs target `main`. Do not manually update a merely-behind branch; the governed
  branch updater merges current `main` and causes the ready suite to rerun.
- PR descriptions must include: **Motivation**, **Description**,
  **Documentation** (what was updated, or why nothing needed it), **Testing**
  (exact commands run), and **Manual testing** where applicable — the PR
  template scaffolds these.

## Documentation policy (maintenance convention)

- Canonical documentation lives in `docs/`.
- Repository markdown files are pointer stubs unless they are `AGENTS.md`,
  `CLAUDE.md`, `CONTRIBUTING.md`, or root `README.md`.
- Preserve existing repo paths as stubs when issues, PRs, or comments may link
  to them; update the `docs/` page a stub links to, not the stub.
- Doc updates ship **in the same unit of work** as the change that makes them
  necessary.
- ADRs are appended, never rewritten. A superseding decision gets a new ADR
  linking back to the one it replaces (see
  [Architecture Decision Records](./adr/Architecture-Decision-Records.md)).
- Use the [Repo Documentation Pointer Map](./Repo-Documentation-Pointer-Map.md) to
  find the canonical page behind a repo path.

## Style

- Prettier owns formatting; ESLint owns correctness. The pre-commit hook formats
  and lints staged files; the pre-push hook runs the complete hosted
  `npm run lint && npm run format:check` chain. Do not mix formatting-only churn
  into feature commits.
- Comments explain _why_, not _what_.
- Dependencies use **exact version pins** — Dependabot is the only actor that
  bumps versions (`scripts/check-package-pins.mjs` enforces this).
- Files stay under the **800-line budget** (ESLint `max-lines` +
  `scripts/check-new-file-size.mjs`); split before you hit it.
