# Validation And Release Gates

Gate-by-gate detail behind `AGENTS.md` → **Validation**. That file states the
rules; this one states what each gate checks, why the ratchets point the way they
do, and which policies exist only as prose. See also
[Testing Strategy](./Testing-Strategy.md) for the test lanes themselves and
[ADR-0001](./adr/ADR-0001-Automation-Check-Governance.md) for the governance
model.

## The chain

`npm run ci` runs the same non-browser gates CI enforces, in order: interop
acceptance → the lint chain → `format:check` → `check:changesets` →
`check:acceptance-coverage` → `check:a11y-budget` → `docs:gov` → `test:cov` →
`build`. Browser lanes (`test:e2e`, `test:stories:ci`) run separately and are
required for E2E- and renderer-relevant changes.

## Workflow runtime policy

Every GitHub Actions job has a finite `timeout-minutes` bound. CI also runs the
required **Workflow runtime policy** job from a reviewed, commit-pinned
`qwts/agent-sop` checker; the aggregate **CI** gate fails when that
policy check fails. Direct packaging, release, versioning, performance, updater,
approval, and issue-automation entrypoints use the same bounded contract even
though they do not all flow through the aggregate CI job.

Network-dependent setup commands use the commit-pinned
`qwts/agent-sop/.github/actions/bounded-command` action. Dependency
installs and Playwright or operating-system setup have explicit per-attempt
timeouts, at most two attempts, and a short fixed retry delay. Tests, builds,
signing, publishing, and other non-idempotent work are not retried by that
contract; their step or job timeout remains the failure boundary. Keep the
workflow definitions, runtime-policy pin, and tooling assertions in
`tests/tooling/` synchronized when changing these limits.

All third-party `uses:` in `.github/workflows/*.yml` are pinned to a full commit SHA with a `# vX.Y.Z` version comment, verified by `pinact run --verify` (config: `.pinact.yml`). The SHA-pinned `true-line/trueline-agent-docs-gov/.github/workflows/docs-governance.yml@67db7dc…` (whose `tooling-ref` input names the same commit) is the same policy — do not regress it to a floating tag. The `true-line/trueline-agent-ci/.github/actions/ci-policy@87c6b301057992f79a723f63c64624bf40c9d06a` pin is the repository's authorization boundary (#1038, #1024): it is immutable, Dependabot ignores it, and `pinact` ignores it via `.pinact.yml`. Re-verify pins with `pinact run --verify`; do not bulk-refresh governed pins. The `zizmor` `unpinned-uses` gate (`.github/zizmor.yml`, job `zizmor` in `ci.yml`) is the continuously enforced backstop that blocks any new unpinned reference; only `unpinned-uses` is merge-blocking until `qwts/agent-sop#6` ships the shared `security-scan.yml` reusable (see [#716](https://github.com/qwts/overlook/issues/716)).

Two gates need an external checkout, both env-gated in the same shape:

| Variable                   | Points at                                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `DOCS_GOV_TOOLING_ROOT`    | a `true-line/trueline-agent-docs-gov` checkout with `tools/docs-gov` at commit `67db7dc9c20bc29222fb605b7ff9432fd58a2a3f` |
| `INTEROP_IMAGE_TRAIL_ROOT` | a `qwts/image-trail` checkout pinned to the commit the manifest names                                                     |

## Advisory semantic checks

The ACA workflow runs eight informational checks. `doc-drift` and
`agent-rule-conflict` are temporarily disabled after repeated stalled judge
steps; their absence is missing advisory coverage, not a passing verdict.
[Issue #1176](https://github.com/qwts/overlook/issues/1176) owns diagnosis and
restoration. Before re-enabling either check, enforce a 120-second deadline
for its entire execution, including requests and retries, abort expired work,
report timeouts distinctly from clean results, and demonstrate useful results
within that limit on representative Overlook changes. Dependency setup may
have a separate bound. The other eight ACA checks remain enabled.

Each enabled check runs through `scripts/run-aca.ts` with a 120-second total
execution budget. Expiry terminates its process group and exits 124 without
publishing a partial report. Missing or malformed reports and unavailable
judges fail the job with exit 78; a bare successful exit is insufficient.
Complete reports retain advisory pass/warn/fail findings. Dependency setup
is outside this execution budget.

## Documentation governance (`docs:gov`)

The deterministic docs-gov check gates `docs/` and the root agent files against
link, orphan, stale-path, heading, token-budget, and anti-pattern rules per
`docs-gov.config.json`
([ENG-0009](https://github.com/qwts/agent-sop/blob/master/docs/decisions/ENG-0009-documentation-governance-gate.md)).

Its implementation is **not vendored**. It lives once in
`qwts/agent-sop` and both halves run it at the `v1` tag: CI via the
reusable workflow `.github/workflows/docs-governance.yml@v1` (the required
`Docs governance / docs-gov` status context), and locally via
`scripts/check-docs-gov.mjs`. The local wrapper verifies the checkout's
`tools/docs-gov` is byte-identical to `v1`, so a local pass proves what a CI pass
proves. Raising a token budget always records a `reason` in the config.

## Ratchets

Floors only ever move in the direction that makes the codebase stricter:

| Ratchet                                                    | Current                   | Direction    |
| ---------------------------------------------------------- | ------------------------- | ------------ |
| c8 coverage (`.c8rc.json`)                                 | lines 90 / branches 80    | only up      |
| `type-coverage --at-least`                                 | 99.8, strict, per project | only up      |
| File size (ESLint `max-lines` + `check-new-file-size.mjs`) | 800 lines                 | only down    |
| a11y violation budget (`tests/a11y/violation-budget.json`) | per surface               | only smaller |
| `AGENTS.md` length (`check-agent-context.mjs`)             | see the script's constant | only smaller |

The a11y budget is the same policy inverted: its counts only ever **shrink**, and
a surface that comes in **under** budget fails until the entry is tightened or
deleted. Unlisted surfaces are budgeted at zero. Never lower a floor to make a
build pass.

## Accessibility runs in three lanes

None of them subsumes the others:

- **`jsx-a11y`** (strict, `src/renderer`) reads the **source**, so pointer-only
  handlers and label/control mismatches fail at authoring time;
- the **story lane** runs axe over every story;
- the **E2E lane** runs axe over composed flows plus the focus-obscured probe for
  SC 2.4.11, which has no axe rule.

A story-lane pass proves nothing about composition, and an axe pass proves
nothing about criteria axe does not implement — roughly two thirds of WCAG. The
[Accessibility Audit](./Accessibility-Audit-2026-07.md) records which criteria
are gated and which rest on the manual pass.

**Never suppress an a11y rule bare.** `reportUnusedDisableDirectives` is `error`,
so every `eslint-disable` must carry a reason: either why the code is verified
correct, or the issue that owns the debt. When the fix lands the directive stops
matching and the build fails until it is deleted — that is the ratchet applied to
exemptions. A blanket `rules: {'jsx-a11y/x': 'off'}` needs the same justification
as lowering a coverage floor.

## Licenses

`lint:licenses` (part of the `lint` chain) audits the **shipped** dependency
closure — production deps of `dependencies` / `optionalDependencies` plus the
bundled `electron` runtime, per `scripts/dependency-closure.mjs`, **not**
`devDependencies` — against the SPDX allowlist in `.license-policy.json`. The
same step verifies `THIRD-PARTY-NOTICES.md` is not stale.

A new or upgraded dependency with a non-allowlisted or undeclared license fails
CI until it is allowlisted or given a reviewed `exceptions` entry with a reason;
then run `npm run licenses:notices` to refresh attributions. A CycloneDX SBOM
(`npm run licenses:sbom`) is emitted into `release/` by the `package*` scripts.

## Dependency policy

Dependencies use **exact pins**; Dependabot is the only actor that bumps
versions (`scripts/check-package-pins.mjs` enforces this). A set of **toolchain
caps** holds back majors that would break the build — TypeScript below 6.1.0
(typescript-eslint's peer cap), `@types/node` tracking the `.nvmrc` runtime major,
Electron on the prebuilt-ABI major, and Vite / `@vitejs/plugin-react` / React held
until `electron-vite` supports Vite 8 and React 19 is migrated deliberately. Each
is a Dependabot ignore; `.github/dependabot.yml` is the source of truth for the
exact bounds and removal conditions.

Dependabot keeps `react-intl` and `@formatjs/intl` in the `formatjs-runtime`
group, and `onnxruntime-node` in `native-inference`, before the general
`dev-tooling` group. FormatJS message-contract migrations and ONNX native
qualification therefore get separate PRs instead of holding routine SDK and
tooling updates (#1170). These groups change batching, not version eligibility;
all existing exact pins, ignore bounds, and validation requirements still apply.

Four overrides exist, each with a removal condition:

- **`axe-core`** is pinned exact and overridden into `axe-playwright` (which
  depends on a floating range). Its rule set _defines_ the a11y violation-budget
  counts, so an unpinned bump would move every number with no diff naming the
  cause. A Dependabot bump of it is _expected_ to move counts: re-audit and
  re-baseline in that PR (`OVERLOOK_A11Y_REPORT=<path> npm run test:stories:ci`),
  never widen the tags or raise a budget to make it pass.
- **`eslint-plugin-jsx-a11y`** is overridden onto `$eslint`. Its latest release
  caps its peer at ESLint 9 and this repo is on 10, so npm refuses the install
  without the override. The rules were verified to actually run under ESLint 10 —
  this is a stale peer range, not an incompatibility. If a bump ever breaks rule
  execution the symptom is jsx-a11y silently reporting **nothing**, so treat a
  sudden drop to zero findings as a failure, not a win.
- **`shell-quote`** is overridden to 1.9.0 because `concurrently` pins vulnerable
  1.8.4 (CVE-2026-13311). Remove when `concurrently` adopts 1.9.0 or later and
  its Storybook orchestration lane passes without the override.
- **`uuid`** is overridden to 11.1.1 because `@storybook/test-runner` resolves
  vulnerable 8.3.2 through `jest-junit` and `nyc` (CVE-2026-41907). Remove when
  the Storybook testing stack resolves only unaffected versions, the
  interaction/report lane passes without it, and the security scan stays clean.

## Packaging checks

- The macOS package job loads the native HEIC decoder from the packaged app and
  decodes the checked-in iPhone fixture. Keep
  `scripts/verify-macos-heic-preview.mjs` and its readiness marker current when
  changing the native bridge, package layout, Electron ABI, or HEIC fixtures.
- The Windows arm64 leg re-resolves the target-arch sharp binary with `npm pack`
  and **verifies the downloaded tarball's sha512 against the exact
  `package-lock.json` integrity entry before extraction** — registry metadata is
  never trusted on its own. `tests/tooling/windows-signing.test.ts` locks the
  gate; keep both in step when changing sharp packaging or the lockfile shape.
- Windows source validation is architecture-aware: complete-suite PR, queue, and
  manual runs execute unit/DOM plus a real copy import on `windows-latest`; every
  main push executes that import on `windows-latest` and native
  `windows-11-arm`. The aggregate `CI` job requires the applicable Windows result,
  so exact-SHA evidence cannot bypass it.
- Package and release runs download each architecture-qualified NSIS artifact on
  a matching native runner. The verifier asserts the runner architecture,
  installs silently, then uses the artifact's exact Electron version and architecture,
  downloaded from Electron's official release and checked against its published
  SHA-256, to explicitly load the installed archive and adjacent unpacked native modules in dedicated
  packaged-only import mode. This avoids the hosted service session's desktop
  bootstrap stall while still verifying the database record, decrypted content
  hash, no plaintext-at-rest leak, and copy-source preservation before a
  `finally` uninstall. The executable verifier is checked out from the trusted
  workflow revision, never the selectable package ref; historical artifacts
  declare the smoke unsupported and skip it without blocking release recovery.

## Changesets and releases

Behavior-changing PRs include a changeset (`npx changeset`). Docs- and
tooling-only PRs may skip the semantic content but still need an **empty**
changeset when none are pending, because `check:changesets` fails on any diff
with an empty `.changeset/`. 0.x semantics (minor = behavior-changing, patch =
fixes) are [ADR-0002](./adr/ADR-0002-Versioning-Policy.md). `CHANGELOG.md` is
generated by `npm run changeset:version` — never hand-edit it.

Overlook is intentionally an npm-private application, not an unpublished
package to omit from release planning. Changesets therefore keeps
`privatePackages.version` enabled so `status` and `version` include the app, but
keeps `privatePackages.tag` disabled because the governed version-cut workflow
creates the reviewed `v*` tag only after exact-SHA CI.

Releases are cut by merging the bot-maintained **Version packages** PR, which the
version-cut workflow keeps current while changesets are pending. That merge is
validated once through the normal ready lifecycle after the governed branch
updater makes it current. Version-cut waits for the exact main-push `CI` gate and
dispatches no equivalent suite before tagging `v0.x.y`.

Release publication fails closed unless the tag is on `main`, version and
changeset state match, the exact commit has successful merge-group evidence (or
a complete main fallback), and the reviewed PR head passed its stable ready-PR
gate. Current user-owned-repository merges use the complete main fallback because
the merge commit rewrites the SHA. Generic CI is reused; release-specific macOS
and Windows builds, packaging,
signing, notarization, SBOM, architecture/signature inspection, HEIC/launch
smoke, artifact upload, checksums/provenance where configured, and prerelease
publication remain mandatory.

Windows ships two architecture-qualified NSIS installers — `overlook-windows-x64`
and `overlook-windows-arm64` (arm64 cross-compiled on the x64 runner) — each gated
post-build by `verify-windows-arch.mjs`, which fails the leg if any payload
(`Overlook.exe` or a shipped `*.node`) is not the target PE machine type.
Each completed installer is then installed on a matching native x64 or ARM64
host. A matching, checksum-verified Electron harness loads that installed archive
and its native modules for the import smoke; cross-compilation is not treated as
runtime evidence.

Release-import unit tests reject result markers in another isolated profile on
every filesystem. The additional case-distinct-directory assertion probes the
actual temporary filesystem and skips only when both spellings resolve to the
same directory; it does not assume case sensitivity from the operating system.
Both fixtures remove their temporary directories after the assertion (#1171).

`prune-foreign-binaries.mjs` runs inside electron-builder before that gate and
keeps only the target payload from packages that bundle multiple platforms:
onnxruntime-node's nested directories and better-sqlite3-multiple-ciphers v13's
flat `prebuilds/<platform>-<arch>.node` set. Universal macOS keeps both Darwin
slices; unmapped targets fail safe by pruning nothing.

ONNX upgrades update the exact `allowScripts` entry with the runtime version
and regenerate third-party notices. `tests/embedding/native-worker.test.ts`
runs a small, locally generated ONNX graph through the real embedding worker:
CPU inference, platform-provider preference, unavailable-provider fallback,
image preprocessing, quantization, and cooperative shutdown. Direct worker
responses must identify the platform provider (CoreML on macOS, DML on Windows)
and CPU for the deliberately unavailable-provider case; silent CPU fallback
cannot qualify an accelerator. Accelerator qualification sets ONNX Runtime's
`session.disable_cpu_ep_fallback` so CPU-assigned graph nodes fail session
creation; a negative CPU control proves the native binding enforces it. Normal
application sessions retain fallback. This runs through
the normal unit-test lane on local macOS and hosted Linux/Windows. Ordinary
Windows coverage verifies CPU inference and normal provider fallback; its strict
DML case reports an explicit hardware-lane skip. The dedicated hardware job sets
`OVERLOOK_DML_QUALIFICATION=1`, requiring DML inference without CPU substitution
and running that strict case. Hosted display-adapter availability therefore does
not stand in for hardware qualification. This proves
native integration with a deterministic fixture, not production CLIP quality
or accelerator performance; packaged payload checks remain separate gates.

The `Native ARM64 DirectML qualification` job runs automatically after the
reviewed policy authorizes a full suite: ready PRs, merge groups, and manual CI
runs. It uses labels `[self-hosted, Windows, ARM64]` (currently `SURFACE-13`),
uses command-scoped Git configuration for LF checkout, asserts native ARM64
Node and Electron, records adapter/driver names, and runs
the strict native-worker fixture with CPU fallback disabled and its negative
CPU control. The stable required `CI` aggregate requires hardware success in
each full-suite lifecycle, including PRs that reuse exact-SHA preflight evidence.
Failed, cancelled, or skipped qualification cannot pass that gate; an offline
runner leaves it waiting. Failed policy checks and draft PRs never select the
laptop. Post-merge smoke retains its existing hosted Windows architecture lanes.
For diagnostics, dispatch CI on an inspected commit with `purpose=diagnostics`;
no separate hardware opt-in is needed. A successful job qualifies only that
commit, runtime, architecture, and adapter; it does not establish x64 adapter
availability or replace the remaining hosted CI results. No secret configuration
is required.

Signing is env-gated on repository secrets: `CSC_LINK` plus `APPLE_API_KEY` signs
and notarizes the mac build; `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` /
`AZURE_CLIENT_SECRET` drive Azure Trusted Signing for the Windows installers
(verified with `signtool`; see [`SIGNING.md`](../SIGNING.md)); restricted Touch ID
identity entitlements are included only when `MAC_PROVISIONING_PROFILE` is also
present and validated.

For `security set-key-partition-list` failures, distinguish the certificate's
`CSC_KEY_PASSWORD` from the temporary keychain password generated by the builder.
Electron-builder 26.15.3 used the former where macOS requires the latter; the
[v26.16.1 upstream fix](https://github.com/electron-userland/electron-builder/pull/10172)
corrects that call. Keep the fixed builder pin when resolving signing failures
([#1195](https://github.com/qwts/overlook/issues/1195)); a password error at this
step alone is not evidence that the certificate secret needs rotation. Validate
with the signed Package workflow, including its signature and Gatekeeper gates.

Release passes credentials to the reusable Package workflow through an explicit
allowlist, never `secrets: inherit`. Package declares every accepted installed-app
OAuth and signing input; its matrix resolves Apple signing values only on macOS
and Azure signing values only on Windows. Adding a Package credential requires a
reviewed update to both the declared interface and the Release mapping.

Every tag publishes as a GitHub prerelease regardless of signing availability.
Each clickable mac and Windows installer asset is labeled `signed` or `unsigned`
from its own platform gate; signing state never changes the release title or
prerelease status. The macOS release gate extracts the generated ZIP and launches
it in an isolated smoke mode. Never hand-tag releases or invoke Changesets
versioning directly.
