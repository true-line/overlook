# M07: Export

**Epic:** [#42](https://github.com/qwts/photos/issues/42) · **Lane:** Lane B — Core

Lane B. The counterpart to encrypted storage: exporting writes real, openable files. ExportDialog per the design — format segmented (Original/JPEG), **"Decrypt originals" switch on by default; turning it off disables Export and shows the amber warning** ("exported files can't be opened outside Overlook"), destination picker, running progress ("Decrypting & writing" vs "Writing"), done summary. Entry points: multi-select action pill and the lightbox export icon (count=1).

## Issues

| #                                                 | Title                                                       | Blocked by         |
| ------------------------------------------------- | ----------------------------------------------------------- | ------------------ |
| [#97](https://github.com/qwts/photos/issues/97)   | Export engine: decrypt + write originals with progress      | #67, #70           |
| [#98](https://github.com/qwts/photos/issues/98)   | JPEG transcode export path                                  | #97, #86           |
| [#99](https://github.com/qwts/photos/issues/99)   | ExportDialog: format, decrypt switch, destination, progress | #97, #59, #60, #61 |
| [#100](https://github.com/qwts/photos/issues/100) | Export entry points: selection action pill + lightbox       | #99, #78, #92      |
| [#101](https://github.com/qwts/photos/issues/101) | E2E: select → export → decrypted files on disk              | #100               |

## Acceptance coverage

| Flow                                                                                                                                         | Status            | Coverage                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------- |
| Export engine: stream-decrypt to destination, collision suffixes, statfs preflight, partial cleanup, serialized runs, cancel-keeps-completed | ✅ #97 (PR #194)  | `tests/export/export-engine.test.ts` (real store, byte-identical)                                                   |
| JPEG transcode (q90, EXIF stripped per ADR-0006, all RAW kinds via preview policy)                                                           | ✅ #98 (PR #195)  | `tests/export/export-engine.test.ts`                                                                                |
| ExportDialog (decrypt-off ⇒ disabled + warning, phases on engine events, cancelled-aware done copy)                                          | ✅ #99 (PR #197)  | `ExportDialog.stories.tsx` play tests + `tests/e2e/export-flow.spec.ts` — ledger id `m07-export-dialog`             |
| Entry points: pill + lightbox with exact counts, selection preserved                                                                         | ✅ #100 (PR #198) | `tests/e2e/export-entry.spec.ts` — ledger id `m07-export-entry-points`                                              |
| Acceptance: select→export→files on disk (sha256-vs-contentHash byte fidelity) + full-circle RAF import → JPEG export                         | ✅ #101 (PR #199) | `tests/e2e/export-flow.spec.ts`                                                                                     |
| Offloaded export reads verified encrypted temporary custody and releases it without silently changing the ledger to synced                   | ✅ #306           | `tests/export/export-engine.test.ts` + `tests/e2e/offload-ui.spec.ts` — ledger id `m08-ephemeral-offloaded-viewing` |
| Export All Unencrypted resolves every ordinary, non-trashed library photo in main, retains original formats, and reports individual failures | 🚧 #885           | `tests/db/library-db.test.ts` + `tests/export/export-runtime.test.ts` + `ExportDialog.stories.tsx`                  |
| Every filesystem export consumes one short-lived, sender- and exact-request-bound destination grant issued by the native folder picker       | ✅ #992           | `tests/export/export-destination-authority.test.ts` + `tests/tooling/export-destination-authority.test.ts`          |

Recorded decisions: v1 ships no encrypted-export format (decrypt-off just disables Export); transcode quality 90; EXIF/GPS stripped on transcode — metadata travels only with Original exports. Renderer-supplied paths never authorize a filesystem export: selected, all, moodboard, and protected-album writes require a one-use native-picker grant; changing the request requires reselection.

## Definition of done

Active cancellation and late-completion evidence:
[Export cancellation acceptance](../acceptance/Acceptance-Test-Export-Cancellation.md) (#1217).

See the epic issue [#42](https://github.com/qwts/photos/issues/42) — the epic body is canonical; this page is the planning index entry.
