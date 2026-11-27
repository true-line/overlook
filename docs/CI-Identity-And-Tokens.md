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

**Verified restoration (#1172): the five App-bound required contexts and strict
freshness were restored at `2026-11-27T21:55:55.927Z` and independently verified
in effective `main` rules.** The interim merge hold is lifted. Before enabling
auto-merge, confirm that this policy still applies and complete current-head
checks have succeeded. If the policy drifts, suspend normal merges and coordinate
with the owner to disable already-enabled auto-merge until repair is verified.
A green head alone cannot close the base-advance race without strict freshness.
See the [current audit](#main-protection-audit--2026-11-27-1172) for settings and
the enforcement evidence still needed before the issue can close. Do not use a
bypass or substitute an immediate merge for requested auto-merge.

`true-line/overlook` is a private repository in the `true-line` organization and
currently retains `.github/workflows/auto-update-prs.yml` until a native merge
queue is rolled out. After a `main` push, PR open, or ready transition, the
workflow uses `chores-dumb[bot]` to merge current `main` into each eligible
ready branch through the update-branch API. The resulting `synchronize` event
runs the complete suite. Strict required checks prevent auto-merge from landing
stale evidence; the audit below records their verified restoration.

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
- Auto-merge uses merge commits. Effective `main` rules require strict status
  checks, approval, CODEOWNERS, and resolved review threads; verify the live
  rules before relying on this contract.

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

The live settings repair is complete. [Issue #1172](https://github.com/true-line/overlook/issues/1172)
remains open for the enforcement evidence below; configured controls alone are
not proof that every negative case has been exercised. Re-read live policy
before acting. The September repair and the first November audit are historical
snapshots, not the current settings.

### Applied settings and publishing Apps

At `main` commit `5101609a7d03eb9757c60ff3d8ff68fce52e4c25`, Agent-Bot's
`update_repository_ruleset_checks` repaired repository ruleset `18825119`
(`default-branch-ruleset`) at `2026-11-27T21:55:55.927Z`. It added the missing
`CodeQL` context and changed `strict_required_status_checks_policy` from false
to true. `do_not_enforce_on_create` remains false. A separate GET of
`/repos/true-line/overlook/rules/branches/main` verified the effective result.

| Required context             | Publishing App / integration ID      |
| ---------------------------- | ------------------------------------ |
| `CI`                         | `github-actions` / `15368`           |
| `E2E gate`                   | `github-actions` / `15368`           |
| `Docs governance / docs-gov` | `github-actions` / `15368`           |
| `CodeQL`                     | `github-advanced-security` / `57789` |
| `zizmor / unpinned-uses`     | `github-actions` / `15368`           |

All five exact contexts succeeded on PR #1501 head
`15bc75b1412c0cdb4b9f2b023bbb3bfa2a633b7a` before the repair. The check-run API
verified these App IDs; the stable `CodeQL` result comes from Advanced Security,
although `ci.yml` calls `codeql.yml` analysis jobs running under Actions.
`ci.yml` also names the aggregate `CI`, `E2E gate`, and
`zizmor / unpinned-uses` jobs and calls the pinned Docs governance workflow.
Do not substitute `E2E`, `zizmor`, or an `Advanced CodeQL / Analyze (...)` job
for the required contexts.

The write receipt is `ghw_f3ea726c1f5acbdb`, recorded with the
[settings evidence on #1172](https://github.com/true-line/overlook/issues/1172#issuecomment-7228893452).
Its canonical snapshots are:

- Before: `460c17b0fabbb045c49abb275862839d97ae0a0826ccbc6ff186b004612473d2`.
- After: `832b50ab0b15c476984579580d762e0266b1f4e5522eeee780df0e7b4a550b76`.

The independently read before/after diff changed only the required-check rule
and GitHub's update timestamp. It preserved active default-branch enforcement,
conditions, deletion/non-fast-forward protection, signatures, one approval,
CODEOWNERS, resolved threads, allowed merge methods, code quality at `errors`,
and CodeQL scanning at `high_or_higher` security / `errors`. Repository
stale-review dismissal was already true immediately before this repair and
remains true; last-push approval remains false. The earlier audit's disabled
stale-review dismissal was superseded by an owner change.

Organization ruleset `22156011` still supplies additional approval, CODEOWNERS,
thread, signature and secret-scanning protections. Its empty required-check list
and strict=false setting do not cancel the repository's stronger check rule.
Organization ruleset `26777468` governs repository transfer. Classic
`branches/main/protection` still returns 404; effective ruleset protection is
active.

`.github/CODEOWNERS` assigns all files and explicit governance paths to `@qwts`.
The live CODEOWNERS error list is empty, and the collaborator-permission endpoint
confirms `@qwts` has admin/push access. Both applicable branch rulesets require
CODEOWNER review; ordinary bot approval does not substitute for it.

### Administration identity and preservation limits

The `trueline-codex-agent` App is configured with `administration: write`, as
confirmed by [live App metadata](https://api.github.com/apps/trueline-codex-agent).
The earlier claim that the installation lacked that permission was unsupported:
a narrowed credential response did not establish the installation's full grant.
The new server-side tool supplied the required administrative execution path;
credentials remained server-side. No App permission change was needed.

The write-authorized before/after reads exposed the existing bypass entry:
`RepositoryRole`, actor ID `5`, mode `always`. It was unchanged and unused.
The bot reports `current_user_can_bypass: never`. Read-only policy responses
that omit `bypass_actors` mean unknown, not empty. The first guarded attempt
made no settings write because the read-only snapshot omitted bypass data;
the complete write-authorized snapshot was reviewed before retrying.

The tool checked the reviewed snapshot immediately before updating and
independently read the result afterward. GitHub does not document an atomic
version precondition for ruleset PUT: a concurrent edit in the final GET/PUT gap
cannot be prevented. The actual after-read reported all unrelated fields
preserved. No bypass was added or used, and no deliberately failing change was
merged.

### Enforcement evidence and remaining acceptance

Record the PR, head/base SHAs, observation time, check App IDs, reviews, threads,
auto-merge state and specific rule evaluation. A combined `BLOCKED` state can
have several causes; identify what the evidence actually demonstrates.

| Condition          | Actual evidence                                                                                                                                                                                                                                                       | Remaining qualification                                                                                                                                                                                            |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Missing / pending  | September #1209 was blocked with missing/pending checks and missing review. Re-read rule suite `4177292642`: the check evaluator failed with `5 of 5 required status checks are expected`; CodeQL scanning and owner review also failed, and the owner used a bypass. | Historical evaluator failure is not a current normal-merge denial experiment. Observe a normal blocked lifecycle with the specific check condition identified.                                                     |
| Failing            | PR #1497 heads `9bcf7e51b392fd9d18001edbd41ec8e0d36b7858` and `6c59304a6fcdf22dd4a540052205bf494532fcdd` have failed `CI` and `E2E gate`; neither head merged.                                                                                                        | Non-merging and failed check results alone do not establish the rejection cause. Capture the check-specific normal gate rejection without merging a failing change.                                                |
| Stale              | Effective `main` policy now requires strict freshness.                                                                                                                                                                                                                | Observe an old green PR become behind a newer base and remain blocked until the governed updater supplies current-base evidence. Record old/new head and base SHAs; do not manually update a merely-behind branch. |
| Valid current head | Re-read suites `4178311121`, `5404943901` (#1497), and `5417655595` (#1499): each reports `pass`, including a separate required-status-check evaluation. #1497's final head had all five contexts successful before normal auto-merge.                                | Record the successful normal lifecycle under the newly restored policy, with complete evidence on its exact current head.                                                                                          |

The post-repair query for failed main rule suites in the preceding month
returned no records. Do not invent negative evidence from that absence. The
historical bypass suite is explicitly not a normal agent-gated merge.

The failed #1497 runs are
[45961495533](https://github.com/true-line/overlook/actions/runs/45961495533) and
[45963563364](https://github.com/true-line/overlook/actions/runs/45963563364).
Its successful exact-head run is
[45965520093](https://github.com/true-line/overlook/actions/runs/45965520093), on
head `ae469b554ce1f7793cbf7c2c690fee13f4b7571b`. `CI` completed at
`2026-11-27T08:36:21Z`, before the merge at `08:36:27Z`.

Keep #1172 open until pending, failing, missing, stale and repaired-policy
positive evidence meet acceptance. Queue auto-merge only after independently
verified effective policy and complete successful current-head checks; preserve
normal CODEOWNER approval and thread requirements. Subsequent issue comments
should record new lifecycle observations without rewriting historical outcomes.
