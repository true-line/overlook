# CI Identity And Tokens

Which identity performs a repository write, and which token may reach which
step. `AGENTS.md` carries the one-line rule; this page carries the reasoning and
the failure modes, so the rule is followable when something breaks.

## Bot identities, not human PATs

**Anything that must start another workflow run authenticates as
`chores-dumb[bot]`** — branch and tag pushes, bot-opened PRs, release
publication, and `gh workflow run`. It is a GitHub App whose installation token
is minted per run from `CHORES_DUMB_CLIENT_ID` / `CHORES_DUMB_PRIVATE_KEY` by
`actions/create-github-app-token`. Privileged writes have no PAT or
`GITHUB_TOKEN` fallback.

The App credentials are stored in protected GitHub Actions environments rather
than repository-level secrets so runs from untrusted branches cannot read them:

- `version-cut` (`version-cut.yml` `publish-version-pr` and `tag` jobs, plus
  `auto-update-prs.yml` `update`): accepts only `main` and scopes each minted
  App token to the job's minimum write permissions (`contents` +
  `pull-requests` for branch/PR updates, `contents` + `actions` for tagging and
  stranded-tag recovery).
- `release` (`release.yml` `publish` job): accepts only `main` and `v*.*.*`
  tags and mints the `contents: write` token immediately ahead of `Create
release` (human approval gates merging the `Version packages` PR on `main`;
  environment required-reviewers rules require GitHub Enterprise on private
  repositories).

`version-cut.yml` runs `prepare-version-pr` on an unprivileged read-only runner
first (`npm ci --ignore-scripts`, `npx changeset status`,
`npm run changeset:version` including `scripts/sync-package-lock-version.mjs`,
and `scripts/validate-version-cut.mjs`) and skips `publish-version-pr` and
`tag` when no version or tag write is needed. When a version PR update is
ready, `publish-version-pr` starts on a clean runner in `version-cut` without
installing dependencies, copies `scripts/validate-version-cut.mjs` and
`scripts/publish-signed-version-commit.mjs` from the trusted `main` commit
before applying the patch with hooks disabled, verifies the single same-owner
rolling PR, and publishes the commit to `changeset-release/main` through the
Git Data API so GitHub signs it. Manual recovery uses default-branch-only
`repository_dispatch` (`version-cut-recovery`) rather than branch-selectable
`workflow_dispatch`. When a tag is needed, `tag` verifies synchronized
`package.json` and `package-lock.json` versions, waits for exact-SHA CI with
the read-only repository token, then mints a fresh App token immediately before
the write; installation tokens expire after one hour. Empty governance
changesets satisfy the PR gate but do not create a Version packages PR or block
stranded-tag recovery; version, tag, and release-verification lanes share
Changesets' semantic release count.

A bot rather than a human PAT, for a concrete reason: a PAT opens the version PR
under an individual maintainer account, which cannot approve its own PR, so every
release cut needed a ruleset bypass. Repository chores get a bot identity; agents
get their own Apps, and the two never share one.

## Why `GITHUB_TOKEN` is not enough

`GITHUB_TOKEN` events normally trigger no downstream workflows. Governed CI also
rejects `github-actions[bot]` in the immutable policy job. That is why a separate
App identity exists at all.

## Token blast radius

Repository credentials must be **absent while third-party tools run**: checkouts
that precede them use `persist-credentials: false`, and tokens are injected only
into first-party steps containing the `git` / `gh` commands that need them.
Release verification establishes exact-commit CI and reviewed-PR evidence before
installing or executing dependencies from the release tag, so tag-controlled
tools cannot influence those evidence checks.

**The App credential may reach only `actions/*` steps and our own `run:` blocks
— never a third-party action**, whose future versions nobody here controls. When a
third-party action is the only thing standing between the App credential and the
run you need, replace it or drop it. Third-party `uses:` are SHA-pinned with `# vX.Y.Z` (`pinact run --verify`, config `.pinact.yml`); `true-line/trueline-agent-ci/.github/actions/ci-policy@8ec38da3` is immutable and ignored by both Dependabot and `pinact` (#1038, #1024); the `zizmor` `unpinned-uses` gate (`.github/zizmor.yml`, job `zizmor` in `ci.yml`) blocks any new unpinned reference — only `unpinned-uses` is merge-blocking until `qwts/agent-sop#6` ships the shared `security-scan.yml` (see [#716](https://github.com/true-line/overlook/issues/716)). Two precedents:

- versioning is a script in `version-cut.yml` rather than `changesets/action`,
  for exactly this reason;
- the E2E-report Pages publish was deleted rather than handed the token.

## Agent identity

Each agent worktree runs as its own `<slug>[bot]` App installation, minted by the
`WorktreeCreate` hook in the harness user-directory configuration
([ENG-0016](https://github.com/qwts/agent-sop/blob/master/docs/decisions/ENG-0016-agent-pr-bot-identity.md)).
`git` and `gh` are the only sanctioned write paths: a GitHub MCP connector
carries the human's OAuth and bypasses both, so a PR appearing under a human
maintainer account despite a working shim means a connector made it. Agent
checkouts use **HTTPS remotes**, because an SSH remote authenticates the push
with the human's key regardless of `GH_TOKEN`.

Commits created with `git commit` in a bot worktree cannot be Verified — the
worktree deliberately sets `commit.gpgsign=false`, since signing a bot's commit
with a human key shows Unverified. The signed-commit skill replays commits
through the Git Data API, which GitHub signs server-side.

## Merge automation

**Interim hold (#1172): do not enable auto-merge or perform normal merges until
an administrator restores the five App-bound required contexts and strict
freshness, and an independent effective-rule read verifies both.** Coordinate
with the owner to disable any already-enabled auto-merge while the gap remains.
This hold applies to the usual queue instructions, including those in
`AGENTS.md`. A green head alone cannot close the race between a base advance and
the governed updater. Keep completed PRs ready for review; do not use a bypass
or substitute an immediate merge. See the [current audit](#main-protection-audit--2026-11-27-1172)
for owner repair and verification steps. Resume the normal lifecycle only after
the repair is verified, with complete successful checks on the then-current head.

`true-line/overlook` is a private repository in the `true-line` organization and
currently retains `.github/workflows/auto-update-prs.yml` until a native merge
queue is rolled out. After a `main` push, PR open, or ready transition, the
workflow uses `chores-dumb[bot]` to merge current `main` into each eligible
ready branch through the update-branch API. The resulting `synchronize` event
runs the complete suite. Under the intended configuration, strict required
checks prevent auto-merge from landing stale evidence; the audit below records
why that guarantee is currently absent.

The final merge commit has a new SHA, so it is not treated as the validated PR
head. Its `main` push therefore runs the complete-suite fallback plus
default-branch CodeQL. The `merge_group` lane and the shared policy action's
narrow merge-queue actor exception remain dormant compatibility until native
merge-queue enablement; they do not justify skipping exact-commit checks.

Worker jobs use explicit `!cancelled()` status conditions so skipped evidence
jobs still permit required fallback work, while superseded runs release their
runners. The bounded aggregate gates retain `always()` to inspect unsuccessful
dependencies; the CI verdict explicitly rejects a cancelled workflow before and after its
ordinary verdict step. The final rejection covers cancellation arriving after
the first rejection was skipped; it cannot retroactively reject a completed job. A cancelled
run is never reusable exact-SHA evidence. GitHub documents the distinction in its
[workflow cancellation reference](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-cancellation).

Keep status functions such as `cancelled()` in job or step `if` conditions, not
step `env`: the latter cannot evaluate status functions and rejects the workflow
before jobs start. The cancelled-workflow rejection and the ordinary CI verdict
therefore use separate step conditions.

To qualify changes to these conditions, observe an active worker in a run on the
PR, then publish a validated follow-up commit on that PR. Record both head SHAs,
run IDs, old worker conclusions, and when the replacement starts. Require normal
concurrency cancellation without force-cancel, no successful old-run CI verdict,
and a passing complete suite on the final head. A manual cancellation alone does
not demonstrate that PR supersession released the concurrency group.

Consequences worth knowing before touching a branch:

- **Never manually rebase, merge `main` in, or "update" a branch that is merely
  behind `main`**. Resolve genuine conflicts on the source branch; otherwise the
  updater owns branch freshness.
- Dependabot branches are excluded; use `@dependabot rebase` before the normal
  ready complete-suite and review lifecycle.
- After any update that changes `package-lock.json`, run `npm ci` before trusting
  local gates. A stale install fails E2E in ways that look like flakes; an
  Electron bump landing mid-session produced two identical timeout failures this
  way.
- After the interim hold is lifted, auto-merge uses merge commits. The intended
  ruleset requires strict status checks, approval, CODEOWNERS, and resolved
  review threads; verify the live rules rather than assuming this contract is
  already deployed.

## Workflow actor boundary

The immutable playbook CI-policy action permits only authorized `true-line`
maintainers, `chores-dumb[bot]`, `dependabot[bot]`, and active `<agent-slug>[bot]`
Apps from the governed roster. It checks both `github.actor` and
`github.triggering_actor`; credentials do not grant actor authorization. The one
system exception requires both actor fields to be `github-merge-queue[bot]`, the
event to be `push`, and the ref to be `refs/heads/main`. That exception cannot
authorize PR, queue-candidate, manual, tag, or non-main events and remains
dormant until a native merge queue is enabled. External fork runs are never
approved.

Every direct non-CI entrypoint runs that same immutable action in
authorization-only mode before checkout, credential minting, or repository
work. This covers the branch updater, Package, Perf, version-cut, release, and
close-linked-issues; their reusable children inherit the gated caller event. A
new direct trigger is incomplete until its policy job and dependency edge exist.

## Manual repository rollout

These settings cannot be supplied by pull-request code and must be applied only
after the replacement contexts first report successfully:

1. Keep **Actions → Policies → Workflow execution protections** disabled. The
   preview picker cannot express event-scoped GitHub system exceptions, while
   using the Write role would authorize unrelated current and future writers.
   Require approval for all external-contributor workflows, never approve
   external fork runs, keep the default workflow token read-only, and retain the
   action-source allowlist and full-SHA pinning.
2. Switch **Advanced Security → CodeQL analysis** from default to Advanced
   after a manual CI run proves both configured languages and the stable
   `CodeQL` context. Do not leave a gap in code-scanning enforcement.
3. Require `CI`, `E2E gate`, `Docs governance / docs-gov`, `CodeQL`, and `zizmor / unpinned-uses` (added in #716; mark required after its first green report on `main`, per the PR's manual rollout note). Bind
   `CodeQL` to the GitHub Advanced Security App and the other four contexts
   to GitHub Actions — never to `chores-dumb`, which initiates privileged writes
   but does not publish check runs. `E2E` still runs in every complete suite, but
   only its stable `E2E gate` verdict belongs in branch protection. Retain the
   CodeQL code-scanning and code-quality rules. Remove an obsolete default-setup
   context only after its Advanced replacement reports successfully.
4. Retain strict status checks, approval, CODEOWNERS, resolved-thread
   requirements, auto-merge, and merge commits. Keep the governed branch updater
   enabled in `true-line/overlook` until a native `MERGE` queue is enabled and
   exact-SHA merge-group validation is proven.

No secret is added merely for actor authorization. The `CHORES_DUMB`
credentials live in the `version-cut` and `release` environments for the
governed branch updater, version/tag automation, and release publication; do not
keep repository-level copies of `CHORES_DUMB_CLIENT_ID` or
`CHORES_DUMB_PRIVATE_KEY`, and `RELEASE_TOKEN` is not consumed by those
privileged writes.

## Main protection audit — 2026-11-27 (#1172)

This is an observed settings record, not a replacement for the merge contract
above. [Issue #1172](https://github.com/true-line/overlook/issues/1172) remains
open: administrative repair and complete negative enforcement evidence are
outstanding. Re-read live policy before acting; the September issue comments
describe settings that have since changed.

### Observed policy and publishers

At `main` commit `b63382e5527fd3606f40b3d0d58615ef983a5fab`, GET
`/repos/true-line/overlook/rules/branches/main`, the ruleset list with
`includes_parents=true`, and both branch ruleset details showed:

- Repository ruleset `18825119` (`default-branch-ruleset`) is active on the
  default branch. Its required-check rule has strict freshness **disabled** and
  requires the four Actions contexts below; `CodeQL` is missing.
- Organization ruleset `22156011` (`protect-default-branch`) also applies to the
  default branch. Its additional required-check rule has an empty list and
  strict freshness disabled; it does not repair the repository gap.
- Both branch rulesets require one approval, CODEOWNERS review, resolved review
  threads, signed commits, deletion protection and non-fast-forward protection.
  Both currently leave stale-review dismissal and last-push approval disabled.
  The repository also requires code quality at `errors` and CodeQL scanning at
  `high_or_higher` security / `errors`; the organization requires secret-scanning
  alert resolution. Organization ruleset `26777468` governs repository transfer.
- Classic `branches/main/protection` returns 404. The effective ruleset rules
  remain active; that response does not mean `main` is unprotected.
- `.github/CODEOWNERS` assigns `*` and explicit governance paths to `@qwts`.
  CODEOWNERS review is already enabled; do not disable it or replace it with an
  ordinary bot approval. The available policy reads report
  `current_user_can_bypass: never` but omit `bypass_actors`; the current bypass
  list is **unknown**, not empty. Historical owner bypass entries are not
  authorization for an agent to bypass.

All five exact contexts succeeded on PR #1497 head
`ae469b554ce1f7793cbf7c2c690fee13f4b7571b`. The check-run API supplies the App
identities below. The Advanced CodeQL analysis jobs run under Actions, but the
stable `CodeQL` result is published by Advanced Security.

| Required context             | Publishing App / integration ID      | Observed required |
| ---------------------------- | ------------------------------------ | ----------------- |
| `CI`                         | `github-actions` / `15368`           | Yes               |
| `E2E gate`                   | `github-actions` / `15368`           | Yes               |
| `Docs governance / docs-gov` | `github-actions` / `15368`           | Yes               |
| `CodeQL`                     | `github-advanced-security` / `57789` | **No**            |
| `zizmor / unpinned-uses`     | `github-actions` / `15368`           | Yes               |

`ci.yml` names the aggregate `CI`, `E2E gate`, and `zizmor / unpinned-uses`
jobs, calls the pinned reusable Docs governance workflow, and calls
`codeql.yml` for Advanced analysis. Do not substitute `E2E`, `zizmor`, or an
`Advanced CodeQL / Analyze (...)` job for the contexts in this table.

### Owner repair procedure

The `trueline-codex-agent` App is configured with `administration: write`, as
confirmed by [live App metadata](https://api.github.com/apps/trueline-codex-agent).
The current Agent-Bot credential request returns a narrower permission map that
omits administration and withholds the raw token. Its exposed policy API is
GET-only, the workspace has no local Agent-Bot daemon/gh shim, and the settings
browser fallback was unavailable. These access-path limitations do not establish
that the App or installation lacks administration permission; the installation's
full grant was not verified. No administrative write was made, and no App
permission change is requested.

An administrator must perform this focused repair:

1. Save fresh administrative GET responses for `rules/branches/main`,
   `rulesets?includes_parents=true`, `rulesets/18825119`, and
   `rulesets/22156011`, including conditions, enforcement and bypass actors.
   Check for concurrent owner changes. Confirm the table's exact names and App
   IDs still have successful check runs on a current complete-suite head.
2. Open [repository ruleset 18825119](https://github.com/true-line/overlook/settings/rules/18825119).
   In **Require status checks to pass**, retain the four existing App-bound
   entries, add `CodeQL` with source **GitHub Advanced Security** (`57789`), and
   enable **Require branches to be up to date before merging**
   (`strict_required_status_checks_policy: true`). Leave the rule active on the
   default branch and retain `do_not_enforce_on_create: false`.
3. Preserve every other rule, approval count, CODEOWNERS requirement, thread
   requirement, signature rule, scanning rule, condition, allowed merge method,
   and existing bypass setting. Do not add or use a bypass. Do not change
   stale-review dismissal as a side effect of this repair. Confirm `@qwts` is a
   valid CODEOWNER with repository write access and GitHub reports no CODEOWNERS
   errors. Retain auto-merge, merge commits and the governed branch updater.
4. Independently re-read the ruleset and effective rules. Verify all five
   `(context, integration_id)` pairs and strict freshness; compare the saved
   before/after snapshots to ensure no unrelated protection changed. An empty
   organization check list does not cancel the repository's stronger rule.
5. Record the actual after snapshot and the evidence below on #1172 and update
   this audit. A documentation PR cannot apply repository settings.

### Enforcement evidence and remaining acceptance

Use read-only observations and real checks on legitimate PRs. Record the PR,
head and base SHAs, observation time, check App IDs, mergeability, reviews,
threads, auto-merge state and any rule-suite evaluation available to the owner.
Never merge a deliberately failing change, synthesize success, bypass a rule,
or count an older head's checks as current evidence.

| Condition          | Evidence observed                                                                                                                                                                                            | Remaining proof                                                                                                                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Missing / pending  | September #1209 was `BLOCKED / REVIEW_REQUIRED` with required checks absent or pending; the issue comments preserve that observation.                                                                        | Review was also missing. Obtain current normal-path denial with review/threads satisfied and identify the absent or pending required context.                                                                                          |
| Failing            | PR #1497 heads `9bcf7e51b392fd9d18001edbd41ec8e0d36b7858` and `6c59304a6fcdf22dd4a540052205bf494532fcdd` have failed `CI` and `E2E gate`; neither head merged.                                               | Check failures and non-merging alone do not prove isolated enforcement. Capture a current blocked normal lifecycle or failed rule evaluation with other gates satisfied.                                                               |
| Stale              | Current strict freshness is false.                                                                                                                                                                           | After repair, observe a previously green, approved PR fall behind `main` and become blocked until the governed updater supplies current-base checks. Record old/new head and base SHAs. Do not manually update a merely-behind branch. |
| Valid current head | PR #1497 final head `ae469b554ce1f7793cbf7c2c690fee13f4b7571b` had all five contexts successful before its normal auto-merge at `2026-11-27T08:36:27Z`. September comments also record a passing rule suite. | Repeat or verify the intended normal lifecycle under the repaired policy; success under the weaker current rule does not prove strict freshness.                                                                                       |

The failed runs are [45961495533](https://github.com/true-line/overlook/actions/runs/45961495533)
and [45963563364](https://github.com/true-line/overlook/actions/runs/45963563364).
The successful exact-head run is
[45965520093](https://github.com/true-line/overlook/actions/runs/45965520093);
`CI` completed at `08:36:21Z` and `E2E gate` at `08:35:39Z`, before merge.
`CodeQL` completed at `08:26:01Z`, Docs governance at `08:25:44Z`, and
`zizmor / unpinned-uses` at `08:25:41Z` on the same date and head.

For each negative case, an approved PR remaining open with auto-merge enabled
is useful lifecycle evidence, but explain any other blocking conditions. Prefer
the administrator's rule-suite rejection identifying the specific check rule
when available. Configuration states the intended restriction; a combined
`BLOCKED` state does not isolate its cause. Keep #1172 open until the repaired
live settings and pending, failing, missing, stale and positive evidence all
satisfy acceptance. Queue documentation auto-merge only after the interim hold
is lifted and its complete current-head checks succeed.
