# Acceptance test — Backup coverage exceptions (#506)

**Keep on this device only…** (photo context menu) takes a photo out of
automatic backup and, when the provider already holds a verified copy,
removes that copy; **Back up again** returns the photo to the ordinary
verified upload. The rules are
[ADR-0033](../adr/ADR-0033-Backup-Coverage-Exceptions-And-Local-Only-Custody.md): the local
original is proven first (a cloud-only original is downloaded and verified
before anything else happens), the decision is recorded durably as
`excluding`, a manifest generation that already records the exclusion is
published, and only then is the provider object deleted — so recovery never
promises a photo the backup no longer holds. A shared encrypted original stays
with the provider while any included photo still references it (§3). A failed
delete leaves the photo "removal pending" with an `ORPHAN-REMOTE` audit line
and is retried by later runs (§6). Removing a provider copy is Tier D and
requires the `photos.remove-cloud-copy.v1` authorization; a photo with no
provider copy merely stops being backed up (Tier M).

Automated coverage: `tests/e2e/backup-coverage.spec.ts`,
`tests/backup/coverage-service.test.ts` (the §2 order, §3 retention, §6
retry, §7 tiers, §5 re-enabling over the real engine and mock provider),
`tests/backup/coverage-manifest.test.ts` (schema 14, restore placeholders,
verified-only projection), `tests/db/backup-coverage.test.ts` (migration 35,
the coverage machine, backup reads), `CoverageDialog.stories.tsx ›
RemovesCloudCopy / KeepsOnThisDevice`.

## Excluded local-custody verification (#1135)

Local custody is verified independently of the remote-presence scrub and of
provider connection/backup success. An unlocked library starts a rolling pass
when maintenance opens and schedules another pass 60 seconds after completion.
Each pass admits at most 50 ordinary excluded rows and a soft 64 MiB budget of
full ciphertext reads. One oversized original may finish a pass; the next
original remains at the durable cursor, so large files do not starve. Stream
memory is bounded, reads cannot grow beyond the observed envelope size, and
lock/library switch aborts active streams and drains before DB/key teardown.

Every visited row gets a stat and envelope-header check. A first observation,
changed file identity/size/nanosecond timestamps, prior failure, or a full hash
at least 24 hours old requires every chunk to authenticate and the plaintext
SHA-256 to match its content address and recorded size. An unchanged header is
not a new cryptographic proof and cannot clear a failure. The daily age is
checked when the bounded walk reaches a row; a large library can take multiple
passes. This avoids rereading all unchanged originals every minute while still
detecting ordinary external edits on the next visit. No plaintext file is
written.

1. Exclude an ordinary photo, disconnect the provider, and reopen the library.
   Let the local pass visit it. The Inspector still describes the backup
   exclusion, local-missing/corrupt counts are zero, and no upload is queued.
2. Save its encrypted envelope from
   `blobs/<first-two-hash-characters>/<next-two>/<content-hash>` for the test,
   then remove the durable original outside Overlook. On the next visit the
   glyph and Inspector say **Local original missing**; the Inspector retains
   **backup remains excluded by choice**. The coverage/statistics surfaces
   disclose missing originals, including while disconnected. Missing bytes
   leave the on-disk total and count once for a shared asset. The exclusion
   count/bytes remain policy totals; they do not turn into pending uploads.
3. Repeat with an invalid header, a truncated final chunk and a changed payload
   byte. Each must become **Local original corrupt**, with a separate corrupt
   count. Corrupt bytes still occupy disk. No provider object is uploaded,
   deleted or borrowed as proof of local custody, and the source envelope is
   not modified. IO permission failures defer the check, not claim corruption
   or recovery.
4. Restore the saved encrypted envelope and let the pass recheck it. Only a
   complete successful authenticated hash clears the finding, red glyph,
   Unavailable membership and error counts. Coverage/origin/since and the
   upload ledger remain unchanged. For a missing original, **Recover original…**
   also accepts the matching plaintext original through the existing verified
   recovery path; this explicit recovery does not re-include the exclusion.
   **Back up again** refuses a known missing/corrupt original until verified
   local recovery/recheck clears the finding; it must not upload failed bytes
   or discard the exclusion merely because a file exists.
5. Repeat with shared variants, including after the import-owner row is
   purged. Verification uses the surviving asset-owner AAD, not the variant ID.
   A missing original counts once in bytes and once per affected photo in the
   finding counts. A large batch resumes from its saved cursor after restart.
6. Lock or switch libraries during a full read. No late healthy/corrupt result
   may be committed after revocation. An absent original or retained key is
   skipped rather than diagnosed as corrupt. Protect a selected row during a
   check: it must disappear from the ordinary pass before any finding commits.
   Protected coverage expansion (#1127) and provider capability classification
   (#1126) are separate decision work, not prerequisites for this slice.
7. Restore an excluded placeholder from backup. It has no promised local
   original and must not become a new local-missing/corrupt finding. Included
   offloaded rows retain the existing remote-custody verification path.

Migration 50 stores findings and verification stamps locally. They survive
reopen but never enter the backup manifest. Excluded rows remain excluded from
the remote-presence query. Automated regression coverage:
`tests/backup/local-custody-integrity.test.ts`,
`tests/library/original-recovery.test.ts`,
`tests/dom/local-custody-state.test.tsx`, and Inspector stories
`LocalOnlyHealthy / LocalOriginalMissing / LocalOriginalCorrupt`.

## Steps

1. Start a new library with the mock provider, import four photos and press
   **Back up**. **Expected:** "All backed up · now"; four encrypted originals
   in the mock remote.
2. Right-click the first photo → **Keep on this device only…**.
   **Expected:** a dialog titled **Remove the cloud copy?** that names the
   provider and account the copy will be deleted from, the byte count, and the
   side-effect sentence; the confirm button reads **Remove cloud copy permanently**.
3. Confirm. **Expected:** the toast "1 photo kept on this device only"; the
   tile's status glyph reads **On this device only**; the Inspector's Backup
   line says the same with the date; the sidebar storage card shows the
   excluded bytes; the mock remote holds three originals; the Back up button
   stays hidden (an excluded photo is not pending work); the status bar's sync
   chip reads "Backed up except 1 local-only photo · now" — never "All backed
   up" while a local-only photo exists.
4. Right-click the same photo → **Keep on this device only…** is gone and
   **Free Up Local Space…** / **Restore original** are gone too; only **Back
   up again** remains. **Expected:** as stated — an excluded photo has no
   cloud copy to offload to or restore from.
5. Select a photo that was never backed up (import one with auto-backup off)
   and choose **Keep on this device only…**. **Expected:** the dialog is
   titled **Keep on this device only**, no provider line appears, and the
   confirm button reads **Keep on this device only**; nothing is deleted.
6. Duplicate a backed-up photo (#496 family), then exclude the duplicate.
   **Expected:** the preflight reports one shared original retained; the
   provider object stays because the root still references it; the duplicate
   is excluded.
7. Disconnect the provider (Settings → Backup) and try to exclude a backed-up
   photo. **Expected:** the photo is listed as skipped with the reason "cloud
   provider disconnected"; nothing changes.
8. Offload a photo (**Free Up Local Space…**), then exclude it. **Expected:**
   the dialog reports one original to download first; after confirming, the
   original is back on disk, the photo is excluded, and the provider copy is
   gone. Kill the network mid-download and repeat: the photo is reported as
   failed ("restore failed") and its state is unchanged.
9. Make the provider refuse deletes (Local mock: make the remote `blobs`
   directory read-only) and exclude a backed-up photo. **Expected:** the toast
   says the cloud copy is still awaiting removal; the status bar shows the
   removal-pending chip; the tile keeps its synced glyph; the audit log has an
   `ORPHAN-REMOTE` line. Restore write access and press **Back up**.
   **Expected:** the copy is removed and the chip clears.
10. Right-click the excluded photo → **Back up again**. **Expected:** the
    toast "Backing up 1 photo again"; the photo runs through the ordinary
    verified upload; "All backed up · now"; the mock remote holds four
    originals again.
11. Delete an excluded photo's local original from disk (outside Overlook)
    and choose **Back up again**. **Expected:** the photo is included but its
    status is the red error glyph — never a false "backed up".
12. Move an excluded photo to Trash and purge it. **Expected:** the purge
    dialog states that the photo has no cloud copy to remove; the purge
    completes without touching the provider.
13. Run a disaster recovery restore from the provider after step 3.
    **Expected:** the validated recovery preview states the deliberately excluded
    count and bytes, separately from missing-object failures. The durable
    `restore-report.json` retains those totals in `coverage`, including when
    `missing` is empty; the placeholder row appears with the red error glyph and
    the "On this device only" coverage text, and the library opens.
14. Open a library backed up before this version. **Expected:** every photo
    is included; migration 35 adds the column with its default and the
    manifest's next generation is schema 14.

## Pending removal followed by purge (#1136)

- Repeat the refused-delete scenario, move that photo to Trash, and open
  Purge. The dialog says its cloud copy may still exist because removal is
  pending. A mixed selection counts settled exclusions separately. Repeat with
  **Empty Trash**, including enough rows to span pages; its counts must match.
- Confirm purge. The photo and its local original disappear (unless a sibling
  still needs the original); migration 39 retains remote cleanup outside the
  photo and sync-ledger cascades. If source custody cannot be captured or the
  queue cannot be persisted, purge fails before removing the photo. Identity
  capture has a ten-second deadline; unbound clean integrity errors, like
  offloaded rows, cannot borrow the selected account as their source.
- Restart, restore provider access, and press **Back up**. A fresh verified
  manifest on the recorded source account must omit the queued paths before
  deletion is retried. A failed publication or delete retains the queue for
  the next backup; retry can therefore cost another manifest generation.
  Audit records use `PURGE-REMOTE-PENDING` and `PURGE-REMOTE-SETTLED`.
- Switch to another account and repeat backup: it must not delete the original
  account's queued objects. Reconnect the source account to complete cleanup.
- Keep an included duplicate while purging its pending-removal sibling. The
  shared original remains; removing that final included claim requires another
  verified publication before its queued deletion can run.

Automated coverage: `tests/library/purge-cleanup.test.ts` (atomic persistence,
restart, sharing, account mismatch and late queue entries),
`tests/backup/backup-engine.test.ts` (publication failure and retry ordering),
and `PurgeConfirm.stories.tsx` (pending, settled and mixed counts).

### Restore byte-boundary regression (#1233)

Restore an exclusions-only backup: activation must retain its placeholder row
without generating thumbnails or verifying an absent original, and report
zero recovered photos. Repeat with one included photo: its bytes must still
verify and count as recovered. Remove that included original and verify it
remains a missing-object failure, distinct from the excluded placeholder.
`tests/backup/restore-excluded-placeholders.test.ts` exercises all three paths.

### Recovery exclusion disclosure (#1125)

The #1125 disclosure slice is covered by `Restore library coverage /
DeliberatelyExcluded` and `tests/backup/restore-coverage-disclosure.test.ts`.
The selection button exposes its exclusion count and bytes as an accessible
description; cards without exclusions have no dangling description reference.
Verification, confirmation, and completion retain the exclusion count and bytes;
completion uses the activated generation, including after fallback or UI reopen.
The durable report records exclusions separately from missing objects.
Bulk placeholder cleanup and origin-specific tile/Inspector copy remain
tracked in #1125; excluded rows are kept by default.

Restore-origin provenance (#1125): a new excluded placeholder records the
manifest generation timestamp in device-local `restored_exclusion_at`. Ordinary
local-only rows and older restored rows remain unmarked; coverage and error
status cannot safely reconstruct that history. The marker survives unrelated
errors and reopen, and clears when verified custody clears original absence.
Later loss must not turn a recovered photo back into a restored placeholder.
This metadata does not enter the backup manifest. The reviewed bulk Trash
action and origin-specific tile/Inspector copy remain follow-on acceptance work.
