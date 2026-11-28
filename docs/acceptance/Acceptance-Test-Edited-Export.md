# Acceptance test — edited export (#497)

Governing contract: [ADR-0031](../adr/ADR-0031-Editing-Variants-Provenance-And-Export-Boundary.md)
§4 (sidecars), §6 (one declared export mode), §7 (meaning before appearance).
Every export declares exactly one payload mode before bytes leave custody:
**Bake** renders the head edit stack into a new JPEG at an explicit quality;
**Original + XMP** writes the byte-identical original beside a generated XMP
that names the supported subset of the edits (rotate/flip as
`tiff:Orientation`, the crop as `crs:Crop*`) plus retained companions; **Original
only** writes the byte-identical original and nothing beside it. The preflight
names every edit the mode cannot carry; nothing is silently omitted.

Automated coverage: `tests/e2e/export-edits.spec.ts`, `tests/export/edit-xmp.test.ts`,
`tests/export/export-engine.test.ts` (edited export), `ExportDialog.stories.tsx › EditLossReport`.

## Steps

1. Launch a seeded library (`OVERLOOK_SEED=4`). Open IMG_4028.JPG in the
   lightbox, rotate it clockwise once, and save with ⌘S. **Expected:** the
   tile re-bakes and the Inspector's Edits section names the rotation.
2. From the lightbox choose **Export**. **Expected:** the dialog's _Edits_
   control offers **Bake**, **Original + XMP**, and **Original only**, with a
   one-sentence hint under the chosen mode. Apple Photos as the destination
   disables the control (Photos receives originals).
3. Choose **Original + XMP**, pick a folder, export. **Expected:** the done
   copy reads "1 photo exported and decrypted. 1 edit sidecar written."; the
   folder holds `IMG_4028.JPG` byte-identical to the imported original and
   `IMG_4028.xmp` containing `tiff:Orientation="6"`. Metadata **Edits** adds the
   title/description/tags to the same packet; Metadata **None** still writes
   the edit sidecar (edits are not metadata). With Metadata **Source** and a
   retained `.xmp` companion, the generated packet keeps the stem
   (`IMG_4028.xmp`) and the companion is preserved as `IMG_4028 (1).xmp` —
   consumers associate XMP by stem, so the edits are what travels.
4. Choose **Bake**. **Expected:** a _JPEG quality_ control appears (Best · 95,
   High · 90, Small · 80). Export. **Expected:** the done copy reads "… 1 with
   edits baked."; the new `.jpg` has its width and height swapped relative to
   the original and carries no EXIF (ADR-0006 stance, stated in the hint).
5. Choose **Original only**. **Expected:** the dialog states "1 photo has
   presentation edits that will not be exported." Export writes the original
   and no sidecar of any kind, whatever the Metadata policy.
6. Crop the photo (C, drag, Enter, ⌘S) and export **Original + XMP** again.
   **Expected:** the packet carries `crs:HasCrop="True"` and crop edges in the
   oriented frame; `parseEditsXmp` (the reviewed reader) returns the same
   transform the lightbox shows.
7. Loss report (manual, needs a newer-build revision): with a photo whose head
   revision carries an operation this build does not know, choose **Bake** or
   **Original + XMP**. **Expected:** the dialog lists "file: operation" under
   "1 edit cannot travel in this mode", Export is disabled until **Continue
   with these losses** is switched on, and **Original only** replaces the list
   with the omitted-edits statement. A baked export of such a photo fails that
   entry honestly ("edit stack has an operation this build cannot render");
   the batch continues.
8. Cancel a multi-photo baked export mid-way. **Expected:** completed files
   stay; the unfinished entry is cancelled and cleaned up. Follow
   [export cancellation acceptance](./Acceptance-Test-Export-Cancellation.md)
   for active IO, late completion and physical-retirement bounds.
9. Export all (library-wide). **Expected:** the same _Edits_ control applies;
   the preflight counts every exportable photo.
