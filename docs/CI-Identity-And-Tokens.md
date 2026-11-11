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

- `version-cut` (`version-cut.yml` `version-pr` and `tag` jobs, plus
  `auto-update-prs.yml` `update`): accepts only `main`.
- `release` (`release.yml` `publish` job): accepts only `main` and `v*` tags
  and waits for maintainer approval before minting the `contents: write` token
  immediately ahead of `Create release`.

Version-cut jobs perform their read-only no-op checks before requiring App
credentials. This lets a Dependabot-initiated main run exit cleanly when no
version or tag write is needed. When a version PR update is needed,
`scripts/publish-signed-version-commit.mjs` publishes the local `HEAD` commit to
`changeset-release/main` through the Git Data API, verifying the published tree
SHA against the local tree and asserting that GitHub signed the commit so the
rolling PR satisfies `main`'s signed-commit requirement. When a tag is needed,
the job waits for exact-SHA
CI with the read-only repository token, then mints a fresh App token immediately
before the write; installation tokens expire after one hour. Empty governance
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

`true-line/overlook` is a private repository in the `true-line` organization and
currently retains `.github/workflows/auto-update-prs.yml` until a native merge
queue is rolled out. After a `main` push, PR open, or ready transition, the
workflow uses `chores-dumb[bot]` to merge current `main` into each eligible
ready branch through the update-branch API. The resulting `synchronize` event
runs the complete suite, and strict required checks prevent auto-merge from
landing stale evidence.

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
- Auto-merge uses merge commits. The ruleset retains strict status checks,
  approval, CODEOWNERS, and resolved review threads.

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
