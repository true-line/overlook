# photos

## 0.76.43

### Patch Changes

- c747b11: Sanitize Google Drive import filenames and enforce destination path containment for exported originals and sidecars (#1428).
- 5b82396: Seal and migrate companion sidecars (`photo_sidecars` and sidecar blobs) across protected album `protect`, `move`, `unprotect`, and crash-recovery rollback phases (#1429).
- 494811e: Preserve full Schema V24+/ADR-0031 photo metadata and variant lineage on unprotect, owe backup manifests on unprotect and protected-album moves, support batch-unprotecting sibling variants, and guard pre-commit unprotect rollback against shared ordinary blob owners (#1430).
- 876d3b5: Preserve preexisting `EEXIST` blobs in `BlobStore.restoreOriginal`/`restoreSidecar` and shared-hash sibling variants in `RestoreEngine` when verification fails (#1431).
- 14cc9ac: Privacy Lock and global protected-album relock now revoke active album generations and evict decrypted protected thumbnails and full-resolution media buffers from memory immediately (#1432).
- 93c3488: Wire `app.lock.now` in the Windows/Linux titlebar Overlook menu and execute `Ctrl+Alt+D` (`library.duplicates`) in the non-macOS keyboard dispatcher (#1433).
- 9ea95d7: Wire `Shift+Delete` (`photo.purge`) in Trash to open the purge confirmation dialog on ordinary photos without opening it outside Trash, align bare-key Cocoa menu accelerators and Lightbox favorite/delete guards with ADR-0024 surface policy, and update the Help README target to `true-line/overlook`.
- ee7f4ba: Harden main-process IPC sender verification, detached Inspector window channel scope and E2E attention routing, locked-library registry mutation guards, offscreen video poster navigation policy, and `overlook-full://` CORS origin validation (#1436).
- 5fe4b8b: Mark backup manifest debt across all committed Undo/Redo/compensation history mutations, enforce activity retention on history events, and recursively reject nested sensitive fields and paths in activity payloads (#1437).
- c2de4b2: Stream Google Drive and pCloud backup uploads without full-stream V8 heap buffering, skip `.overlooklibrary` package bundles during folder import scans, and await background worker shutdown when closing library maintenance services (#1438).
- e501e54: Chunk SQLite ID bind lists, index `album_photos(photo_id)`, batch Smart Album listing counts, and deduplicate shared-asset byte totals in `PhotosRepository.stats()` (#1439).
- eea7aca: Fix `windows-interop` hoisted `node-gyp` lookup, clean up staged File Provider and PhotoKit temporary files on error/cancellation, harden `native_drag.mm` filename validation, exclude `binding.gyp`/`test*.cjs` from packaged builds, and sync `package.json` `allowScripts` with `package-lock.json` (#1440).
- 3e48f49: Fix renderer metadata/grid async races, align Quick Actions and titlebar accessible names with WCAG 2.5.3 while trapping outside-panel Tab focus, enable text selection on error diagnostics, and migrate remaining hardcoded English strings to react-intl (#1441).
- 913a47f: When an Export mode can't carry some edits, the dialog now lists them calmly (up to five, then how many more) and asks you to confirm exporting without them with a checkbox that resets whenever the list changes. An unavailable Export button now says why beneath it, including when a public destination withholds a field (#1307).
- 913a47f: The Export dialog's “What leaves” preview now asks for a Destination (Named recipient or Public), with a hint for each. Disclosure class badges are neutral with an icon (lock, people, globe) instead of warning colours. Including a withheld field uses the app's standard checkbox, and the blocked notice is announced calmly rather than as an alert (#1308).
- 913a47f: The Export dialog's disclosure preview is easier to read: consent copy (the embedded-metadata, blocked and sidecar notes, and the “Include … in this export” choice) is now regular body text at the small size instead of the tiniest, faintest type; only the loading, empty and cancel notes stay faint (#1309).

## 0.76.42

### Patch Changes

- 2b29582: A keyboard shortcut pressed the moment a dialog closes or the Lightbox opens is no longer dropped: for example, pressing I right after closing Keyboard Shortcuts now opens the Inspector every time (#1279).

## 0.76.41

### Patch Changes

- 6bc1ca2: The selection pill now collapses one action at a time, in a fixed priority order, as its content area narrows, and ⋯ holds exactly the actions missing from the pill, using the shared menu. An unavailable Export stays focusable with its reason visible (#1304).
- 0b65e95: Review Duplicates: a protected Original now explains itself in its row instead of showing a disabled button with a tooltip. Trash buttons stay focusable while a move runs, focus moves to the next candidate afterwards, and the move is announced once, with the groups left (#1305).
- e4a9f75: The Export dialog's Edits and JPEG quality settings are now standard field rows: each control is named by its label, the Edits choice is described by the selected mode's hint, and both wrap cleanly in narrow windows and longer languages (#1306).

## 0.76.40

### Patch Changes

- 39fd23a: More and overflow buttons (selection pill, photo tiles, feed cards, list rows, album rows) now use the ellipsis glyph instead of the filter-like sliders icon (#1303).

## 0.76.39

### Patch Changes

- 3890dd0: Keep the Settings shortcut to ⌘, on macOS. On Windows and Linux, Ctrl+, stays unbound and the Overlook menu shows no shortcut for Settings…, which opens from that menu and from the sidebar card.

## 0.76.38

### Patch Changes

- 141be6c: Windows and Linux get an Overlook menu (⋯) in the titlebar, next to Help. It holds the File, Edit, View, and Overlook commands that macOS keeps in its menu bar, grouped under those headings with their shortcuts. Unavailable commands stay listed and say why, such as Export All while a protected album is open. Transfer & Sync and Export All Unencrypted leave the toolbar, so Import is its only primary action on every platform.
- 141be6c: The toolbar no longer wraps onto two rows at the default window size. It stays one row at every width and makes room in a fixed order: the zoom slider moves into a Zoom popover, the wordmark keeps only its mark, Import becomes icon-only, and view selection becomes a View menu. Focus follows a control into its compact form, and changing the view is now announced.

## 0.76.37

### Patch Changes

- d89e01d: The Settings section list is now only as wide as its longest label (160 to 200px) and lines up with the dialog title. In a narrow Settings dialog, such as a 960px window at 200% zoom, the sections become a row of tabs above the pane instead of squeezing it. The arrow keys move between sections in either layout.

## 0.76.36

### Patch Changes

- 79f793e: Library switcher rows now have one ⋯ button beside the library instead of a checkbox and four icon buttons. The ⋯ menu (also opened by right-click, Shift+F10, or the Menu key) lists Edit display name…, Rename folder…, Move…, and Remove library from list…. An action a library can't take stays in the menu, disabled with the reason. To move several libraries at once, choose Move several… below the list and check the ones to move; checked rows are highlighted. After any of these, focus returns to where you started. Dialogs now keep a 16px margin from the window edge at any zoom.

## 0.76.35

### Patch Changes

- d4d57bf: All Photos in Settings → General is now a subsection with its own heading instead of rows nested inside another row. Its two rows sit at the pane's indent, and screen readers announce it as the All Photos region. The switch now reads "Show unavailable items".

## 0.76.34

### Patch Changes

- fecb52e: Search mode moves from a permanent Auto / Semantic / Keyword control beside the search field into a menu button inside the field. The button names the mode when it isn't Auto, each mode carries a short description, and Semantic explains why it can't run yet while it indexes or is turned off.
- 2703ccd: Settings rows no longer squeeze their labels. A control that would leave its label narrower than 220px now wraps below the label. Hints read in muted body text at a comfortable width. Each control is named by its row's label and described by its hint, so screen readers read both on focus without repeating the label. Compound settings such as Custom themes and Quick Actions span the row under their label.

## 0.76.33

### Patch Changes

- edf224a: On macOS, the toolbar no longer shows Transfer & Sync or Export All Unencrypted; both stay in the Overlook and File menus, and Import is the toolbar's only primary action.

## 0.76.32

### Patch Changes

- bdd7991: Stop showing a lone dash while library stats load: the status bar says "Counting photos…" and the sidebar storage line waits until there is something to show.

## 0.76.31

### Patch Changes

- 6d5f688: Keep the library switcher's keyboard hint on one row, and drop it when the dialog is too narrow for it.
- b35253b: Set the sidebar's not-connected sentence through the shared prose type class instead of copying its rules.

## 0.76.30

### Patch Changes

- 23e113f: The library switcher's move checkboxes no longer print "Select {name} to move" beside each row; screen readers still announce it. `Checkbox` gains a `hideLabel` option, and the visually-hidden utility now loads globally, so hidden labels stay hidden in Storybook and detached windows too.
- a05b8fd: Make "Connect" in the sidebar's not-connected line a link-style button with a 24px target, instead of turning the whole sentence into one button.

## 0.76.29

### Patch Changes

- 863a357: Style scrollbars from the design tokens: a thin bar that brightens on hover, an overlay on macOS when the system hides scroll bars, and system colours in forced-colours mode. Every scroll container now scrolls vertically only. Settings rows wrap a control below its label when it does not fit, so the Settings pane, including Finder access, no longer scrolls sideways.

## 0.76.28

### Patch Changes

- 9e7d02f: Set hints, notes, errors, status sentences, and relative times in sans sentence case instead of uppercase mono, so they wrap and read like prose. Paths, counts, hashes, EXIF values, and short labels stay mono. Preview-unavailable, locked-key, and dimension-mismatch messages are now sentence case in the catalog, with the `KEY #` identifier left as is.

## 0.76.27

### Patch Changes

- 17a7367: Keep a same-Mac login-keychain copy of each library master so a Safe Storage password change can still open the library.
- b9731ce: Raise all renderer text to the 11px `--text-xs` floor: photo-tile pills, the quick-actions target, Protected Originals, sidebar storage, and the video player now read from the type scale. Tile pills that no longer fit at small zoom drop to their glyph, with the label kept for screen readers; the trash retention pill gains a clock glyph. `lint:tokens` now rejects literal font sizes.

## 0.76.26

### Patch Changes

- 4d581d2: Replace hard-coded corner radii and font weights in the app's styles with the design scale: form fields and inputs use the 4px control radius, photo tiles and the moodboard use the tile radius, Interop panels use the card radius, and circles use the full radius. The photo tile's "Original" pill now uses semibold (600) instead of an off-scale bold (700). `lint:tokens` now also fails on a literal `border-radius` or `font-weight` in renderer CSS.

## 0.76.25

### Patch Changes

- 3d14a54: Fix Review Duplicates, Activity, Interop, Keyring, Protected, Restore, the detached Inspector window, and the Diagnostics payload reading design tokens that don't exist, which left them with no corner radii, the wrong text size, and transparent surfaces. A new `lint:tokens` check now fails on any renderer stylesheet that reads an undeclared custom property.

## 0.76.24

### Patch Changes

- dc7d64b: Show a recovery screen when this Mac cannot unwrap the library master key, instead of a blank photo tile.

## 0.76.23

### Patch Changes

- 585138f: Recover a missing original from a matching local file while preserving shared ownership and backup coverage.
- e2c0a1a: Update the Electron runtime and the ESLint React plugin, with refreshed third-party notices.
- 85ba837: Update the shipped Anthropic and OpenAI SDKs, with refreshed third-party notices.
- 150416f: Update the TypeScript ESLint lint tooling.

## 0.76.22

### Patch Changes

- 364d2f9: Preserve device-local provenance for excluded placeholders created by disaster restore.
- ded89d8: Route explicit video preview and dimension repair to the video poster decoder.

## 0.76.21

### Patch Changes

- 4a87afc: Update the FormatJS localization runtime dependencies.
- 4156ef5: Add per-photo preview and dimension repair actions to the Inspector and context menu.
- 3348bf5: Prepare exact-photo video poster repair through the existing bounded decoder queue.

## 0.76.20

### Patch Changes

- 7949ee8: Update the shipped Anthropic and OpenAI SDKs and Zod, with refreshed third-party notices.

## 0.76.19

### Patch Changes

- 680298e: Recheck the complete selection before Export and Duplicate, skip photos whose keys are absent with an accurate count, and disable native and selection-pill pixel actions when no selected photo can be opened.
- 5939368: Track missing originals independently from preview failures and upload errors so consistency repair updates Unavailable membership accurately.
- c1c955a: Update the native ONNX runtime with matching install-script authorization and third-party notices.
- 72e8379: Seek directly into date and name indexes when paging large libraries, preserving cursor tie-breaking and gallery inclusion rules.

## 0.76.18

### Patch Changes

- 89232a3: Update the Electron runtime and build-toolchain dependencies, including the shipped third-party notices.

## 0.76.17

### Patch Changes

- 92f5786: Disclose deliberately excluded photo counts and bytes throughout recovery and on completion and preserve them separately from missing objects in the restore report.

## 0.76.16

### Patch Changes

- c5cab5b: Coalesce background fingerprint progress counts so fast indexing and deferral bursts do not repeatedly scan the entire library. Explicit status reads and final completion counts remain current.
- 3983127: Add an exact-photo repair path that preserves sibling variants and retries recorded preview and dimension failures through the existing repair queue.

## 0.76.15

### Patch Changes

- 851d412: Expose a typed read-only query for key availability across a complete ordinary-photo selection, including offscreen rows and distinct locked or unavailable counts.
- bd9f72a: Restore focus to the new-album button after successful creation commits its enabled state.

## 0.76.14

### Patch Changes

- f42f6cf: Reduce background duplicate-index candidate scans while retaining per-photo cancellation and yielding.
- 4154903: Disable single-photo export and duplicate menu actions when the photo key is absent, with a Custody explanation.
- 28223f2: Allow cloud restore to retain deliberately excluded placeholders without requiring absent original bytes, and keep them out of recovered-photo counts.
- c01243c: Avoid recounting the embedding index solely to determine semantic-query readiness.
- f7a205c: Upgrade the localization runtime with generated ICU argument contracts while preserving translated and rich-text messages.

## 0.76.13

### Patch Changes

- 47f070a: Rebuild deferred edit previews when an original returns, preserving the latest edit head across repair races.

## 0.76.12

### Patch Changes

- 7b5f328: Bound legacy and offload custody identity lookups so an unresponsive provider cannot stall them indefinitely.
- 4f413df: Bound manifest publication and preserve unresolved metadata writes across cancellation and library reopen.
- 5f44f21: Move sidebar albums and folders across folder boundaries with atomic sibling placement and preserved drag feedback and focus.
- eef77d8: Refuse export batches containing locked photos before any content or destination work, with guidance to import the missing keys.
- a7097aa: Prevent renderer requests from reopening the source library while relocation copies it, and preserve failure diagnostics before the renderer reloads.
- 429914e: Preserve album names for retry after failed sidebar creation and show actionable errors when album visibility changes fail.

## 0.76.11

### Patch Changes

- cc86acf: Preserve local variant preview failure diagnostics while retaining repair debt.
- a670df5: Keep deferred variant availability accurate during upgrades and refresh filtered galleries after preview repair.

## 0.76.10

### Patch Changes

- a641508: Remember deferred variant previews and regenerate them with their saved edits when the shared original is restored locally.

## 0.76.9

### Patch Changes

- 5c2319c: Preserve imported companions across variant duplication and root purge, including export, backup and restore, and shared-object cleanup.

## 0.76.8

### Patch Changes

- 25b83d8: Skip backup work for photos whose encryption key is absent, preserve their dirty state and manifest records, and restore their pending count when the key is imported.

## 0.76.7

### Patch Changes

- 9d91db9: Update electron-builder to 26.16.1 to fix macOS signing using the certificate password to unlock its temporary keychain.

## 0.76.6

### Patch Changes

- 747ea10: Bound purge source-identity lookup and refuse unverified legacy clean-error custody before removing a photo. Empty Trash also distinguishes pending removal from settled exclusions across every page.

## 0.76.5

### Patch Changes

- ceec268: Distinguish pending cloud removal in the purge dialog and retain its remote cleanup across purge and restart until a verified source-account backup permits retry.

## 0.76.4

### Patch Changes

- 9357e3c: Keep a restored protected album in its saved folder when deleting its ordinary row left a gap in collection positions.

## 0.76.3

### Patch Changes

- a738249: Preserve an album's folder, sibling order, inherited visibility, and tags through protection, with an activity note when its original folder is unavailable on return.

## 0.76.2

### Patch Changes

- 31d3a84: Read protected-migration originals with the shared asset owner and preserve variant-specific derivative custody through recovery.
- a26ee5c: Walk repeated edit reverts back through restored states to the empty root while preserving every revision.

## 0.76.1

### Patch Changes

- d68a1d5: Project folder-scoped album and folder creation labels from the shared command registry.
- 72e02cf: Keep surviving albums selected when moving folder contents, and clear selection for recursively deleted descendants.

## 0.76.0

### Minor Changes

- 3ca3fd6: **AI-generation provenance.** The Inspector gains a **Provenance** section that shows what a photo's own bytes say about how it was made, as evidence tiers rather than a verdict: **Verified provenance** (a Content Credential validated for these exact bytes), **Declared** (XMP, EXIF, PNG, or sidecar metadata naming a generator, an AI edit, a tool, or a capture — shown verbatim and marked "not verified"), **Detected** (a reviewed detector with its version, confidence, and limits), and **Unknown** (no supported evidence — explicitly not a claim that a person made the image). Everything is evaluated locally with no network path; a present Content Credential that this version cannot validate is reported as present but unverifiable, never as verified. Evidence is bound to the photo's bytes and re-checked when they or the checker change, stays inside the encrypted library, and rides in backups (manifest schema 12, library schema 32).
- 5e6754e: Albums can be organized into **folders**. A folder button next to the Albums heading creates one; a folder's actions menu creates albums or folders inside it, and every album or folder can be moved with **Move to folder…**, reordered among its siblings, and collapsed by clicking the folder row (disclosure is per-profile view state and is not backed up). A folder's **Hide from All Photos** setting is the default for the albums inside it that have not set their own; a child's menu shows when it follows the folder and offers **Use folder setting** to return to it. Albums and folders take organizational **Tags…** in their own vocabulary, separate from photo keywords. Deleting a non-empty folder asks whether to move its contents or to remove the structure, naming the exact number of folders and albums involved; photos are never deleted. Folders nest at most six levels deep, and the tree, folder policies, and tags are library data carried by backup and restore (manifest schema 9, database schema 29).
- 5a79cd2: Albums gain **Hide from All Photos** / **Show in All Photos** in their actions menu. A hidden album keeps every photo in its own view, in search, in other sources, in export, and in backup; only the All Photos presentation changes, and a photo leaves it only when every album containing it is hidden. The menu discloses how many photos stay visible through other albums and offers to open them, the sidebar marks hidden albums, the status bar reports how many photos album settings hide, and the policy is library data carried by backup and restore (manifest schema 8, database schema 28).
- 95ab8bc: Keep on this device only (photo context menu): a photo can be taken out of automatic backup, and when the provider already holds a verified copy that copy is removed — after the local original is proven, the decision is recorded, and a manifest generation that already says so has landed, so recovery never promises what the backup no longer holds. Removing a provider copy is an irreversible-tier confirmation that names the provider and account; a photo with no cloud copy simply stops being backed up. A shared encrypted original stays with the provider while another photo still references it; a failed removal is retried by later backups and shown as pending. Back up again returns the photo to the ordinary verified upload. Backup manifests move to schema 14 and record what they deliberately do not hold; restore recreates those photos as honest placeholders.
- 9208957: Disclosure (Settings ▸ Privacy): every classifiable metadata field — title, description, tags, capture time, camera, lens, provenance, precise location, ratings, face data, comments — carries a class: Private never leaves the library, Shared may go to a named recipient (a folder you choose, Apple Photos, a keyed provider, a paired peer), Public may go to an unauthenticated destination. Nothing defaults to Public; precise location, ratings and face data default to Private. Key material, blob addresses, protected-album existence, custody state and diagnostics identifiers are always private and cannot be reclassified. Export and Send to Apple Photos show what leaves before it leaves: which fields, how many photos carry them, a sample value, and whether a withheld field is embedded in the original bytes — in which case the export is refused until you include that field for this one export (recorded in Activity) or export Baked. Policy changes and per-export widening are recorded in Activity by field name and class only. The File Provider mounts a library date only when capture time is disclosed.
- 9eb4018: Export declares one payload mode for edited photos (ADR-0031 §6): **Bake** renders the saved rotation, flip, and crop into a new JPEG at an explicit quality; **Original + XMP** writes the byte-identical original beside an XMP sidecar naming the edits (`tiff:Orientation`, `crs:Crop*`); **Original only** writes the original and nothing beside it. A preflight names every edit the chosen mode cannot carry and Export waits for the user to continue with that loss or pick another mode.
- fb5b6d9: **Feed view.** A fourth view beside Grid, List, and Moodboard: one reading-width column of cards, each showing the photo's title (the file name until one is set), the image, and the description (a compact placeholder until one is set), with the date, place, and camera underneath. The Feed is a layout of the same virtualized engine, so only the visible cards mount, pages arrive through the same cursor, and selection, favorites, the Inspector, the context menu, albums, filters, and Smart Albums all work as they do in the grid. Images paint the cached thumb first and fade the larger preview in (no fade under reduced motion); offloaded and unavailable photos show their usual states. Closing the lightbox returns to the same card and scroll position, arrow keys walk the column, and a title or description saved in the Inspector repaints the visible card at once. **View → Feed** is now enabled.
- d7d6f2c: The sidebar gains derived **RAW** and **Unavailable** sources with exact counts, and Settings → General → All Photos adds inclusion rules: show or hide unavailable items and a minimum size with an explicit "None — show every size" default. Rules change only what All Photos shows, unknown dimensions are never treated as zero megapixels, the status bar discloses how many photos a rule hides, and the rules are library data carried by backup and restore (manifest schema 7, database schema 27).
- 3969819: The Inspector shows a histogram for the focused photo: red, green, blue and luminance bins with clipping indicators, computed in the main process on a worker thread from the photo's own preview (the saved edits already applied), so it follows paging, variants and saved rotations or crops without blocking the lightbox. Missing or undecodable previews say so instead of drawing a chart.
- f12dd1d: Encryption keys (Settings ▸ Privacy): the library keeps a keyring — every key it has ever sealed photos under, with its reference, fingerprint, what it still seals, and whether this device holds it. A retired key can be exported to a password-sealed key file and removed; removing a key that still seals photos is an irreversible-tier confirmation that counts them, and those photos stay in the library as locked items (a lock stands in for the thumbnail, the Inspector and lightbox say which key is missing) until the same key file is imported again, which verifies the key against a photo before installing it. Backup manifests move to schema 15 and carry the keyring, so a restore whose recovery bootstrap lacks a key yields locked photos instead of a refusal.
- e688ec6: Review Duplicates (File menu, ⌥⌘D): Overlook compares every photo's own preview on this device with a rotation-aware perceptual fingerprint and groups the photos that look alike — recompressed, resized and rotated copies — with the evidence for each. Matches are suggestions: Move to Trash is the ordinary delete (protected Originals are preserved and counted), an Original never pairs with a non-Original, intentional variants are never candidates, and nothing is merged or shared. The fingerprints are recomputable index rows beside the photo, never part of a backup.
- 9fe6cb9: **Persisted edits.** Rotating, flipping, and cropping a photo in the lightbox can now be saved: **Save edits** (⌘S) writes an immutable edit revision, **Reset edits** returns to the original, **Revert** steps back to the previous revision, and **Crop** (C) opens a drag-to-frame surface applied with Enter. Edits never touch the original file — every revision is a small document appended to the photo's history, the thumbnail and preview are re-baked from the original with the saved transform, and the grid, lightbox, and Inspector (a new **Edits** section) all show the result. Revisions ride in backups (manifest schema 11, library schema 31) and restore unchanged; a revision written by a newer version of Overlook is kept and shown as view-only rather than dropped.
- f1ec04d: **Smart Albums and facet filters.** The toolbar's **Filters** button now opens a facet bar (File type, Megapixels, Camera, Lens, Location, Tag, Favorite, Custody, Availability). Values inside a facet are an inclusive union — Shift-click or **Add to selection** widens it — and facets compose by an explicit **Match all** / **Match any**. **Save as Smart Album…** stores the current predicate as a collection that re-evaluates every time it opens; it shows the same photos as the live filter that made it, can be edited and saved back, duplicated beside the original, moved into folders, tagged, and deleted without ever touching a photo. Photos with unknown dimensions never match a size range. A Smart Album written by a newer version whose query this build cannot evaluate is kept unchanged and shown with an explanatory empty state instead of an unfiltered grid. Smart Album predicates are library data carried by backup and restore (manifest schema 10, database schema 30).
- e1d3224: Settings → Appearance can now export a theme template: a complete `.overlook-theme.json` capturing every effective design token with a one-line description per token, ready to hand to a person or an LLM and re-import as-is.
- e154281: **Variants.** A photo can now be **duplicated** into a sibling variant over the same original: the context menu and the Inspector gain **Duplicate**, which creates a new library row that shares the one encrypted original (no bytes are read for custody or rewritten), starts from the source's metadata and current edit as its own root revision, sits in the same albums, and bakes its own previews under its own derivative key — so editing one variant never touches another's thumbnails. The Inspector's new **Variants** section lists every live variant on the asset, opens any sibling in the lightbox, and lets you **Promote** one as the family's representative (reversible metadata; custody never moves). Trash and purge stay honest for families: purging a variant removes only its own previews, and the shared original, its cloud copy, and its sidecars go only when the last variant — live or in Trash — is gone. Duplicate lineage and representatives ride in backups (manifest schema 13, library schema 33, which rebuilds the photos table to allow several rows per original).

### Patch Changes

- f745ee0: The Add to album picker's menu now holds only its album rows; the inline "New album" field sits beside the menu instead of inside it, so assistive technology reads the menu as a menu.
- f745ee0: Removing protection from an album with more than one photo no longer fails with a derivative-key conflict: each restored photo is written back under its own derivative key.

## 0.75.1

### Patch Changes

- 7dd55ce: Pin third-party Actions to SHAs and add constrained zizmor unpinned-uses gate (#716)

## 0.75.0

### Minor Changes

- 02c864e: Add on-device semantic photo search with automatic keyword fusion, explicit search modes, and truthful fallback status.

## 0.74.6

### Patch Changes

- 16b8048: Add safe profile-scoped user theme import, validation, preview, persistence, removal, and native recovery controls.

## 0.74.5

### Patch Changes

- 92f834f: Add required native Windows x64 and ARM64 import validation to pull request, main, and release CI.

## 0.74.4

### Patch Changes

- b294026: Add accessible copy controls for exact cloud recovery identifiers, remote paths, provider accounts, and recovery errors.

## 0.74.3

### Patch Changes

- 00424bd: Allow Windows imports to flush writable staging files before publication without `fsync` failing with `EPERM`.

## 0.74.2

### Patch Changes

- a923d85: Allow Windows imports and Move compensation to complete without unsupported directory fsync calls, and update the transitive js-yaml dependency to its patched release.

## 0.74.1

### Patch Changes

- dff6ec2: Allow release recovery to package historical tags that predate the optional native Windows interop component.

## 0.74.0

### Minor Changes

- fd6113f: Route authenticated live local Move and Sync sessions through the existing encrypted transport and durable journals.

## 0.73.0

### Minor Changes

- e77184b: Add the protected Windows named-pipe bootstrap for live local interoperability.

## 0.72.0

### Minor Changes

- 7f878a7: Add the authenticated macOS live-local interoperability bootstrap, including
  the signed native-host handoff, user-scoped control socket, short-lived
  capability redemption, lock/shutdown teardown, and exact-owner native-host
  unregistration for disable and uninstall flows.

## 0.71.1

### Patch Changes

- 2fd4abb: Require main-process confirmation bound to the exact permanent-purge request.

## 0.71.0

### Minor Changes

- 1dea4dd: Surface exact provider custody requirements before disconnect and wherever cloud-only original access fails.

## 0.70.6

### Patch Changes

- 383b2ac: Accept recovery-key files by drag and drop during cloud restore with explicit invalid and multi-file feedback.

## 0.70.5

### Patch Changes

- 5445dad: Disable the crash-prone native macOS photo drag session while preserving internal album dragging and inbound file drops.
- 584fce8: Migrate encrypted SQLite to its Node-API v13 runtime while preserving resolved types and target-pure native packages.

## 0.70.4

### Patch Changes

- 232a742: Legacy backup manifests now migrate to the current field contract in one place, when they are parsed for restore: optional fields whose absence does not round-trip through a rebuilt catalog are normalized per their documented contracts (absent `mediaInfo` becomes null). Every supported manifest schema era (2–6) is covered by a regression test that restores an era-exact manifest end to end, so a future manifest field addition fails tests instead of rejecting existing backups as corrupt.

## 0.70.3

### Patch Changes

- f501f7e: Restore no longer fails with "rebuilt catalog does not match the verified projection" for backups made before probed media info existed: the catalog equality check now normalizes an absent `mediaInfo` to null, per the manifest schema contract. The restore error panel's Copy error button now uses the app clipboard bridge, so it actually copies.

## 0.70.2

### Patch Changes

- 5940372: Preserve the File Provider application identity in signed macOS packages.

## 0.70.1

### Patch Changes

- 1708103: Limit reusable release-package credentials to an explicit interface and expose
  Apple and Azure signing values only to their matching platform legs.
- b3ef8d4: Require one-use native-picker authorization for every filesystem photo export.
- 84cbf67: test: run every test lane, then fail once

  `test:run` chained the unit, renderer DOM, and guard-conformance lanes with
  `&&`, so the first red lane skipped the rest. Under `test:cov` that also
  distorted coverage: the DOM lane covers the renderer files `.c8rc.json` admits,
  and a lane that never runs reports them at 0%, which is enough to breach the
  line floor on its own. The lanes now run through `scripts/run-test-lanes.mjs`,
  which runs all of them, names every failure, and keeps the non-zero exit CI
  reads.

  The PR coverage summary also gains a margin column — how many covered lines or
  branches a run can lose before the floor breaks — because a percentage two
  decimals above its floor hides how little room that is.

## 0.70.0

### Minor Changes

- e99048a: Present custom libraries as Finder packages with identity-aware double-click routing and a privacy-safe Quick Look summary on macOS.

### Patch Changes

- 1a9af04: Restore verify shows Heal, Discard, and Do nothing. Missing or corrupt objects do not block recovery, and nothing is deleted unless Discard is confirmed.

## 0.69.0

### Minor Changes

- 509e1b2: Add an explicitly enabled, read-only macOS File Provider location for ordinary Overlook libraries and albums.

## 0.68.1

### Patch Changes

- 0956567: Require main-process confirmation before local Move imports can delete source originals.

## 0.68.0

### Minor Changes

- 7384d0c: Follow the operating system's high-contrast preference with reviewed dark and light palettes, and map Windows forced colors to native system colors.
- 9d174d3: Export Moodboards as color-managed PNGs at declared dimensions.

## 0.67.6

### Patch Changes

- 34a0108: Make double-click Fill in full view actually cover the viewport: the image now scales by the larger viewport-to-image ratio, so it reaches all four edges and overflows only the single longer axis, instead of leaving bars beside square, near-square, and moderately proportioned photos.

## 0.67.5

### Patch Changes

- 3e646b4: Treat cloud restore object presence as getStream, not a provider listing miss, so a complete backup is not restored as empty.

## 0.67.4

### Patch Changes

- f120505: Keep verified-only cloud restore from aborting on extra gaps, show 1/N verify and restore progress, and let closing the dialog reopen the still-running job from the status bar.

## 0.67.3

### Patch Changes

- b7f9a0d: Keep intact app-lock credentials usable after local anchor loss, offer an authenticated hardened recovery policy, and enter recovery after three failed unlock attempts.
- 7a6da68: Capitalize the existing OS profile directory as `Overlook` without changing its children or custody files.
- 117828a: Recover stale library locks after disconnects and report genuine lock conflicts without sending users to recovery.

## 0.67.2

### Patch Changes

- d51de02: Keep square and sub-pixel near-square photos wholly visible when double-clicking the lightbox while preserving one-axis Fill for landscape and portrait photos.

## 0.67.1

### Patch Changes

- a6df036: Publish the provider-relative `Overlook Interop/v1` root and Drive owner in the shared v1 contract.

## 0.67.0

### Minor Changes

- 6105304: Add accessible copy actions to load-bearing Inspector, Activity, import,
  export, recovery-key, and diagnostics values.
- 29fa96e: Add registry-only library display-name editing, reset-to-folder-name, duplicate disambiguation, and live titlebar updates.
- 330fa1d: Add signed macOS file-promise drag-out for selected ordinary photos.
- 4a9a79a: Add encrypted, searchable photo titles, descriptions, imported keywords, authored tags, bulk tag management, and metadata-aware export choices.
- 4c8249d: Add explicit, signed Apple Photos import and add-only export with reviewed selection, lock-aware custody, and plaintext staging cleanup.
- 47b87b2: Make rendered machine data selectable by default and add an accessible,
  announced copy primitive for load-bearing values.

### Patch Changes

- 648009a: Keep repeated pCloud disconnect requests idempotent after the first request
  clears custody, repair the restart fixture, and cover legacy custody failures.
- a5c0d81: Show Windows shortcut labels in the Windows toolbar and shortcut reference.

## 0.66.0

### Minor Changes

- 86c6eeb: Bind every backup-provider connection to a stable, non-secret account identity
  and show its persisted account label in provider status.
- de32dcd: Route cloud-only original reads, restores, integrity checks, and remote deletion
  through their recorded provider account and library namespace.
- 6a48c14: Require account and authenticated library-namespace proof before cloud-only
  custody resumes, and reconcile legacy offloaded rows one verified object at a
  time through the bounded integrity scrub.
- 37504c3: Block provider disconnects and account switches while cloud-only originals
  still depend on that authorization, and preserve recoverable provider-required
  state when authorization is removed through the emergency ceremony.

## 0.65.6

### Patch Changes

- be2c750: Update backup status, sidebar, and Inspector provider names immediately when a
  different disconnected backup provider is selected in Settings.

## 0.65.5

### Patch Changes

- 797a5ff: Restore everything that verifies when no retained cloud backup generation is
  complete, instead of failing the whole restore over a single missing object.
  Unrecoverable objects are reported in full as NOT FOUND, kept visible in the
  library as errored rows, listed durably in restore-report.json, and filled in
  by re-running the restore after they are recovered on the provider.

## 0.65.4

### Patch Changes

- 5a9851f: Re-enable pCloud in release builds when the configured OAuth client ID is
  available, while retaining the explicit build-time kill switch.

## 0.65.3

### Patch Changes

- 329a40c: Select every photo in the complete active library, album, search, and filter result instead of only the loaded gallery page.
- d3b8faa: Apply complete Select All favorite actions to unloaded photos, preserve refined complete selections across page refreshes, and let Shift+Delete escalate protected Originals that sit on pages the grid has not loaded yet.

## 0.65.2

### Patch Changes

- ddbf2df: Add library-wide export of unencrypted original files.
- 5d66b23: Select complete Shift-click and Shift-keyboard ranges across virtualized gallery rows and active album, search, and filter projections.

## 0.65.1

### Patch Changes

- ee3dee0: Keep the library switcher reachable when the startup library is app-locked and held by another Overlook instance.

## 0.65.0

### Minor Changes

- 9034d91: Common video and Apple/iPhone media import as first-class library items: MP4/M4V, QuickTime MOV (H.264, HEVC, ProRes), WebM, AVI, MPEG-PS, and provisional Matroska classify by byte signature — never by extension — with bounded probes recording container, codecs, duration, dimensions, rotation, frame rate/VFR, audio presence, and HDR color hints. Audio-only MPEG files classify as audio, never as fake video. Playability stays a per-device runtime derivation: MP4/QuickTime/WebM play when every stream decodes locally; AVI, MPEG-PS, and Matroska are preserved-only (imported, protected, backed up, exported) with honest playback-limitation UI. Range-served playback MIME follows the probed container.
- a570d41: Photos imported beside XMP or AAE sidecar files now carry those companions into encrypted custody by default: discovered by basename next to the original, encrypted per photo with the association authenticated in the envelope, imported under the same Copy/Move verified-then-delete transaction, included in backup manifests and restore, exported beside the original under its resolved name, and purged with the owning photo. Companions that match no photo are reported in the import summary, never silently dropped.
- 251a2f5: Rename a library folder in place from the library switcher: the new name appears in Finder or Explorer while the library ID, keys, encrypted database, albums, backup links, and display name stay untouched. Renames run through the journaled relocation engine (crash-safe, refusal-first), validate names conservatively for every platform the disk might visit, and support case-only renames on case-insensitive filesystems.

### Patch Changes

- 3463d3d: Require app-locked libraries to be opened and unlocked before relocation.

## 0.64.3

### Patch Changes

- 2b1502a: Fix a whole-app crash (SIGABRT) when switching libraries or pausing indexing while an embedding was being computed: terminating the ONNX worker mid-inference made onnxruntime throw into the torn-down worker environment. Workers now retire cooperatively — the in-flight job settles first, and a hard terminate remains only as a backstop for a wedged worker.
- 41cd05b: Judge library-lock staleness by a stable machine identity instead of the hostname, so a crashed instance's lock is reclaimed even after the hostname drifts with network state (`.local` ↔ `.lan`). Startup now fails loud when the selected library is lock-held by another instance, naming the holder and pointing at the library switcher instead of leaving the user in a different library.

## 0.64.2

### Patch Changes

- 05dfce1: Windows packages ship only the target architecture's onnxruntime binaries again. The v0.64.0 and v0.64.1 builds bundled foreign-architecture binaries, failed release verification, and were never published — this release supersedes both stranded tags.

## 0.64.1

### Patch Changes

- 6038083: Import journal now appends per-file stage transitions (with periodic compaction) instead of rewriting the whole batch manifest on every transition, and import progress events no longer rescan the batch — importing a 100k-file card no longer costs O(N²) CPU/IO or gigabytes of allocation churn. Crash-safety is unchanged: torn writes never corrupt previously journaled state, and journals written by earlier builds still resume.
- 7cef492: Fix the performance collapse that froze the app for days after a 113K-file import. The backup sweep re-materialized the entire dirty set (~94K rows) after every item to publish the pending count (O(N²)) and re-queried ledger status twice per item before the first upload; the pending count is now tracked incrementally and the dirty query carries the status. SQL helpers cache prepared statements per connection (statement re-preparation was ~25% of profiled CPU), the SQLCipher page cache is sized to 64MB so B-tree seeks stop re-decrypting pages, and ten consecutive transient upload failures now abort the run (dirty rows resume next run) instead of burning retries on every remaining item while the network is down.

## 0.64.0

### Minor Changes

- fdbfd83: Add an opt-in on-device photo embedding pipeline with encrypted, resumable vector storage.

## 0.63.0

### Minor Changes

- 06f336d: Compose production Move and Sync services and register the signed macOS iCloud native messaging host.

## 0.62.0

### Minor Changes

- c6954b9: Add durable source-custody provenance for cloud-only originals.

## 0.61.7

### Patch Changes

- 941cae4: Harden AES-GCM authentication tags and renderer permission handling.

## 0.61.6

### Patch Changes

- a045a0a: Fix the Windows ARM64 installer silently omitting every ARM64 binary. electron-builder compresses the NSIS payload with a downloaded 7-Zip 24.x, which auto-applies its ARM64 branch filter (method `0A`); the much older `nsis7z` plugin that unpacks the payload at install time cannot decode that filter and skipped each affected file while reporting success. `Overlook.exe` and 10 ARM64 DLLs were therefore missing from the install directory, leaving a complete-looking installation with no executable to launch. The Windows legs now pin `ELECTRON_BUILDER_7Z_FILTER=BCJ2`, which `nsis7z` can decode; filters are reversible, so extracted bytes are unchanged.

## 0.61.5

### Patch Changes

- 262e73e: Fix the Windows signature-verification step in the Package workflow: it called `signtool.exe`, which isn't on `windows-latest`'s `PATH` (the first real release run failed here even though Azure Trusted Signing itself succeeded). Switched to PowerShell's builtin `Get-AuthenticodeSignature` cmdlet instead.

## 0.61.4

### Patch Changes

- 8ff7a94: Windows installers now sign via Azure Trusted Signing instead of Authenticode. `electron-builder.yml`'s `win.azureSignOptions` replaces `signtoolOptions`, and the Package workflow authenticates with `AZURE_TENANT_ID`/`AZURE_CLIENT_ID`/`AZURE_CLIENT_SECRET` instead of `WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD`. See `SIGNING.md` for the required secrets and verification steps.

## 0.61.3

### Patch Changes

- 7f614f8: Prevent iCloud Drive async completions from aborting the app during shutdown by draining raw native operations and suppressing JavaScript callbacks after environment teardown begins (#752).
- 61b3cb1: Keep unreadable iCloud backup namespaces from blocking a valid library restore.

## 0.61.2

### Patch Changes

- a4b5a9a: Hide pCloud backup and Transfer & Sync features unless an opt-in build includes a public pCloud client ID.

## 0.61.1

### Patch Changes

- bb807e9: Remote deletions are recoverable everywhere the provider supports it (#750): Google Drive now trashes (`PATCH {"trashed": true}`, 30-day Drive trash) instead of issuing permanent `DELETE /files/{id}`; pCloud's trash-backed `deletefile` (60-day Trash) and iCloud Drive's Recently Deleted (30 days) are documented as relied-upon contracts. The provider contract now states the product rule: no code path may permanently destroy a remote object where a recoverable deletion exists.

## 0.61.0

### Minor Changes

- eec1176: Restoring with this Mac's stored key now demands fresh app-password authority whenever an app lock is configured — enforced in the main process, sharing the lock's unlock throttle — and a restore granted that authority re-establishes the password-derived app-lock record with a matching credential anchor for the activated library, instead of leaving it on downgraded keychain-form custody (#754).

### Patch Changes

- 7b763fc: Restoring a library no longer strands the next launch on the app-lock
  "Recovery required" screen: activation reconciles the ADR-0013 freshness
  anchor so the restored library reads as its true lock state instead of a
  rollback attack. A restore that never activates leaves the anchor untouched.
- 4c0b066: The Restore-from-cloud dialog no longer carries a failed attempt's error,
  session, or library list across provider changes or Back — every screen
  reflects only the current provider's discovery.

## 0.60.4

### Patch Changes

- b782e45: Never publish a backup manifest generation the selected provider cannot honor:
  publication preflights every referenced ordinary and protected object against
  the provider's own listing, re-uploads locally available originals it is
  missing, and otherwise fails the run closed with durable manifest debt instead
  of sealing an unrestorable generation. A confirmed remote-only loss now fails
  the backup truthfully (no publish, no prune) rather than refreshing the
  manifest, provider switching is refused unless the target provably holds every
  cloud-only original (switching back to the provider that holds them heals rows
  a wrong-provider integrity pass stranded in 'error'), and restore continues to
  reject incomplete generations while falling back to complete retained ones.
  Restore from cloud backup can now use this Mac's stored master key — an open
  library restores its own backups without the exported recovery-key file, which
  stays required only for fresh-machine recovery.

## 0.60.3

### Patch Changes

- 1ed9497: Bind development and packaged launches to the Overlook application profile, remove the obsolete application identity, and keep the local mock provider exclusive to the E2E harness.

## 0.60.2

### Patch Changes

- 6b65091: Restore Settings cloud-provider activation and native capacity calls without recursively measuring remote library contents.

## 0.60.1

### Patch Changes

- cb5ba37: Render provider connections immediately after authorization while storage usage and quota refresh independently with cancellation and a deadline.

## 0.60.0

### Minor Changes

- 2a9f527: Remove the native application menu on Windows/Linux; add a titlebar Help menu
  (#699, ADR-0024 §5 amendment). The native menu bar is a macOS-only design
  surface, so `buildApplicationMenuTemplate` now returns an empty template on
  win32/linux and the controller sets no application menu there. Every command
  stays reachable through the existing toolbar, sidebar, titlebar, and keyboard
  surfaces; the two otherwise menu-only Help commands (`help.activity`,
  `help.open`) move to a new `TitlebarHelpMenu` — a no-drag `circle-help` button
  left of the window controls that opens the shared APG `ContextMenu`, mirroring
  the macOS Help menu (Keyboard Shortcuts, Activity…, Privacy & Diagnostics,
  Overlook Help) from one shared `HELP_MENU_ITEMS` list so the two Help surfaces
  cannot drift, and deletes the `otherApplicationMenuTemplate`. Activity stays a
  Help affordance, never a sidebar row (#690). Both native command surfaces share
  one executor — `useNativeCommandRouter` now returns its `runCommand` so the
  titlebar menu dispatches the identical registry handlers as the macOS menu. A
  narrow `help:open` IPC lets the renderer open external help, and `circle-help` /
  `keyboard` join the icon vocabulary.

## 0.59.0

### Minor Changes

- 1e0349f: Add MPEG-TS media support (#548), the MPEG-TS rows of ADR-0026 §2/§3/§5. The
  `FileKind` enum gains `video` and `audio` (moved in lockstep across its
  duplicate copies); `.ts`/`.mts`/`.m2ts` and `video/mp2t` are classified by a
  validated 0x47 packet-cadence signature — never the extension — into
  `FileKind.video` with container "MPEG-TS". A bounded, dependency-free PAT/PMT
  probe records the elementary-stream inventory, audio presence, and a PCR
  duration into the extended media-info record; a truncated or hostile stream
  degrades to `probeIncomplete` (preserved-only) rather than failing import.
  Playability is derived per device at runtime (H.264 + AAC playable via the §5
  remux path, everything else preserved-only) and is never persisted into library
  rows, backup manifests, or interop payloads.

## 0.58.0

### Minor Changes

- ba365fa: Report real backup usage on the provider storage cards and redesign the status
  presentation (#684). Each connected card now shows two independently-sourced
  figures that never blend: **Used by Overlook** — the exact byte sum of
  Overlook's own remote objects, measured through the storage-provider seam — and,
  separately, account-wide **capacity**, shown as a bar only when a verified quota
  API supplies it (Google Drive `about.storageQuota`, pCloud `userinfo`). iCloud
  has no trustworthy account-quota API, so it reports the used figure plus an
  honest "iCloud capacity — View in System Settings" route and never fabricates a
  total or passes off local Mac disk space as account capacity. The
  `STORAGE USAGE NOT REPORTED` line is gone.

  The card gains loading, offline/stale (last-known figure retained and marked
  stale with its timestamp), and calculation-failure states; a usage or quota
  failure no longer flips connection authority. Usage refreshes after backup
  completion, reconnect, and app restart, plus a manual Refresh. Connection
  authority, auth, backup/restore/offload, and Touch ID behavior are unchanged.

## 0.57.0

### Minor Changes

- c83a667: Wire the macOS menu's newly-projected commands to their cross-surface handlers, completing #689. File → Move Library… / New Library… open the library switcher (New Library… straight into create mode); File/Photo → Export Selection… / Export… open the Export dialog for the focused photo or selection; Edit → Clear Selection clears the selection; View → Toggle Sidebar shows/hides the sidebar (new `sidebarOpen` state); Photo → Toggle Favorite / Add to Album… / Remove from Album / Move to Trash / Restore act on the focused lightbox photo or the intentional selection, sharing the same handlers and target resolution as the toolbar and context menu (ADR-0024 parity). Each item is disabled with its enablement reason when there is no deterministic target. The native-command router was extracted from `Shell` into `useNativeCommandRouter`.
- df83336: Include moodboards in encrypted backup and restore (part of #515). The backup
  manifest advances to schema 5, carrying each board with its ordering/identity as
  canonical serialized layout; restore rebuilds the boards into the staged catalog
  and the post-restore deep-equality check now verifies boards alongside photos
  and albums. This completes the backup/restore half of invariant I2 — a board's
  exact layout survives a backup and restore round trip. Schema-4 manifests remain
  readable; boards are absent from them and restore to none.
- 6316eea: Persist moodboards in the encrypted library (part of #515). Boards are now
  stored as album-class organizational metadata inside the whole-DB SQLCipher
  `library.db` (migration 18): board-level fields in columns, the ordered
  placement list as canonical byte-stable JSON. The Moodboard view loads its
  board on open and saves layout changes back (debounced) over new zod-validated
  `board:*` IPC channels, so a board survives app restart and library switch — a
  switch reloads the renderer against the newly activated library, restoring the
  exact layout (invariant I2). Placements are references with no photo foreign
  key, so deleting a photo leaves an honest "unavailable" placement rather than
  cascading the layout away. Backup/restore inclusion of boards lands in a
  follow-up slice.
- 9335ac1: Undo/redo for moodboard layout edits through the shared activity history (part
  of #515, ADR-0024/0025). Each committed gesture (the canvas coalesces a gesture
  into one debounced save) records a single undoable `board.layout` command whose
  inverse is the canonical before/after board, so ⌘Z reverts one gesture at a
  time and ⌘⇧Z re-applies it — capability-checked and idempotent like every other
  undoable command. Undo/redo rewrites the board in the main process and pushes a
  `board:reload` event so the open canvas reflects the reverted layout instead of
  overwriting it. Board layout changes now appear in the Activity log.
- 0227a20: Publish native Windows ARM64 installers alongside x64 (first slices of #683).
  The Package/Release workflows now build a Windows leg per architecture on the
  x64 `windows-latest` runner and emit architecture-qualified NSIS installers
  (`Overlook-<version>-<arch>.exe`, uploaded as `overlook-windows-x64` /
  `overlook-windows-arm64`) so the two can never overwrite or be confused. A new
  `verify-windows-arch.mjs` gate reads the PE machine type of the installed
  `Overlook.exe` and every shipped `*.node` (sharp, encrypted SQLite) and fails
  the leg on any mixed-architecture payload from a bad cross-compile. Windows
  Authenticode signing is wired env-gated behind `WIN_CSC_LINK` /
  `WIN_CSC_KEY_PASSWORD` (SHA-256 + RFC 3161 timestamp, verified with
  `signtool`), mirroring the macOS signing foundation; a tag is a full release
  only when every platform can sign. Builds stay unsigned pre-releases until the
  owner supplies the certificate. Ships the ARM64 signed-release manual
  acceptance checklist.

### Patch Changes

- a9911d1: Verify the Moodboard view end to end and fix a rendering bug it caught (part of
  #515). A new Electron E2E confirms the view renders in the real app and a
  board's layout survives an app restart byte-stably (invariant I2), and a
  scale/perf test exercises the board domain at 250 placements (correctness at
  scale plus a generous hot-path budget). The E2E surfaced that the canvas
  collapsed to zero height inside the shell's (non-flex) content area — it now
  fills that area the way the grid does, so the Moodboard is visible in the app,
  not only in isolated stories.

## 0.56.0

### Minor Changes

- 1d7e72d: Rebuild the macOS application menu to the design-system `MenuBar` six-menu spec (#689): **Overlook · File · Edit · View · Photo · Help**, in exact order — dropping the Window menu, flattening the Settings-sections submenu into top-level Overlook items, always showing Lock Now (disabled without an app password), and making the Photo menu target-aware (Restore in Trash; Favorite / Add to Album / Remove from Album / Export / Move to Trash otherwise). New registry commands project into the menu — `library.move` (⇧⌘M), `library.new`, `view.sidebar.toggle`, `view.mode.feed`, `view.mode.moodboard` — plus native exposure for `photo.export` (⇧⌘E), `selection.clear`, `photo.restore`, and album add/remove, with `library.import` bound to ⌘I. Their cross-surface handlers land in a follow-up, so newly-projected items stay disabled for now. Windows/Linux menus are unchanged.

## 0.55.0

### Minor Changes

- 0d6f639: Move Activity to a Help-menu command surface (#690). Activity is a command
  (ADR-0024 / ADR-0025), not a library source or album, so its misplaced row
  beneath the sidebar ALBUMS `+` control is removed. It now projects from the
  shared registry as `help.activity` ("Activity…", `database`) in the Help menu,
  opening the same `ActivityDialog`; the command is per-library and disabled while
  the library is locked.
- 213acc9: Add a Moodboard library view (first slice of #515). A new fourth library view
  joins Grid and List: a pannable, zoomable dot-grid canvas of freeform photo
  _placements_ — drag, resize, rotate, layer, group, align/distribute, and a
  board-settings panel — built on a pure, process-free board domain
  (`src/shared/moodboard`) whose transforms never mutate originals and serialize
  byte-stably. Placements are references, so one photo can appear on many boards
  and many times on one board. The canvas is a labelled `role="application"` with
  a parallel screen-reader reading-order list, a full keyboard map for every
  pointer gesture, a single serialized polite live region, and honest
  offloaded/unavailable/locked placeholders (locked content never rasterizes).
  Persistence, undo, and color-managed export land in follow-up slices.
- e5c2a9a: Keep the signed iCloud acceptance contract isolated when unrelated Overlook backups already exist.

## 0.54.0

### Minor Changes

- 57a48ae: Wire the opt-in LLM assistant's provider custody to IPC: list, connect, and disconnect cloud providers over the validated `llm:*` channels, exposed on `window.overlook.llm`. Keys are validated against the provider before they are sealed into OS-keychain custody, and never cross back to the renderer.

## 0.53.0

### Minor Changes

- 980fd97: Add the production pCloud inbound Move workflow to Transfer & Sync.

## 0.52.0

### Minor Changes

- df45fcb: Add persistent, accessible album reordering from drag handles, keyboard controls, and album action menus.

## 0.51.0

### Minor Changes

- 1056377: Import manually discovered Image Trail Move originals into encrypted native custody and upload resumable acknowledgements.

## 0.50.0

### Minor Changes

- 795f805: Add the opt-in cloud LLM assistant foundation (ADR-0018 §7): provider contract, sourced pricing manifest with pre-request estimate and post-request cost math, OS-custody API-key store, Anthropic/OpenAI/xAI adapters and runtime, and the zod IPC surface. Cloud-only and strictly opt-in; a fresh install makes zero LLM network calls.
- 7114f09: Wire iCloud Drive into provider selection, encrypted backup, offload, rehydration, and restore surfaces.

## 0.49.0

### Minor Changes

- 3c88d97: Define and validate the encrypted Move message and original-blob wire contract.
- 4a6fb8b: Add protected pairing custody, isolated pCloud interoperability authorization, and durable inbound Move discovery state.

## 0.48.0

### Minor Changes

- 22d40c8: Add the macOS iCloud Drive encrypted backup provider and deterministic recovery contracts.

## 0.47.0

### Minor Changes

- 501daf6: Add persisted Dark, Light, and System appearance modes with synchronized native chrome and dual-theme Storybook coverage.
- 5d0bb96: Add a protected Original marker, duplicate-policy boundary, and authenticated Shift+Delete override.

### Patch Changes

- 69442ed: Honor reduced-motion preferences across the renderer and keep core controls reachable at 200% application zoom.

## 0.46.1

### Patch Changes

- abb2d41: Keep the docked Inspector aligned with lightbox and multi-photo selection state.

## 0.46.0

### Minor Changes

- 10a17c0: Add configurable Command-hover Quick Actions to gallery photos with shared context-menu and touch access.

## 0.45.0

### Minor Changes

- dc36c03: Standardize accessible context menus for photos, albums, and Trash around the shared command registry.

## 0.44.0

### Minor Changes

- be3330b: Add durable, capability-aware Undo and Redo for favorites, album membership, Trash, restore, and verified Move compensation.

## 0.43.0

### Minor Changes

- ea1f3a3: Add screen-reader landmarks, collection position metadata, descriptive photo names, and queued announcements for navigation and async photo workflows.

## 0.42.0

### Minor Changes

- 6a1b324: Add first-class GIF and WebP support: signature-based classification, animated originals preserved byte-identically through import/export/backup/interop, static posters in grids, full-viewer animation with a reduced-motion play action, and probed animation facts recorded per ADR-0026.

## 0.41.0

### Minor Changes

- 8a6da36: Add discoverable lightbox rotate and flip shortcuts with Option/Alt inverse actions and non-US keyboard layout support.

## 0.40.0

### Minor Changes

- ed85d55: Add encrypted, per-library activity history for imports, organization, favorites, Trash, export, and permanent deletion.

## 0.39.0

### Minor Changes

- 6be417b: Add a native application menu with direct Settings routes, stable library navigation, privacy-safe state, and lock-aware window recovery.

## 0.38.0

### Minor Changes

- bc7d79a: Add context-aware keyboard commands, shortcut help, roving photo-grid navigation, and complete lightbox keyboard controls.
- 3281b34: Allow local-folder and dropped-file imports to Move originals after explicit consent and verified encrypted custody, with exact moved and retained outcomes.

### Patch Changes

- 5cddf43: Require fresh Move consent after a local import folder is cleared or replaced.

## 0.37.1

### Patch Changes

- 359c48f: Add a library-scoped Off, 7, 30, or 90-day Trash retention setting with a 30-day default.

## 0.37.0

### Minor Changes

- 0fa40c3: Add a persisted language setting that applies locale and text direction live without restarting Overlook.

### Patch Changes

- 517b22b: Use orientation-normalized decoded dimensions for supported images and flag EXIF mismatches as possibly corrupt metadata in the Inspector.
- 0b68fb6: Standardize Trash, restore, and permanent-delete language; add the 30-day retention countdown; and require main-process authorization for irreversible photo purge.

## 0.36.4

### Patch Changes

- 4604523: Let keyboard users pan zoomed lightbox images with the Arrow keys while preserving photo navigation on axes that do not overflow.

## 0.36.3

### Patch Changes

- aa975db: Reserve monotonic AES-GCM envelope nonce prefixes for each versioned library key so large libraries cannot reuse a random 64-bit prefix.

## 0.36.2

### Patch Changes

- a06f851: Keep full-resolution lightbox transitions stable with delayed loading feedback, decode-gated display, and explicit failure states.

## 0.36.1

### Patch Changes

- a53f72a: Align the lightbox transform controls with the handoff design across standard and compact window sizes.

## 0.36.0

### Minor Changes

- eee37f2: Format dates, counts, storage sizes, and relative times for the active locale.

## 0.35.4

### Patch Changes

- 7f191c5: Make gallery favorite stars accessible controls that update favorite state without opening or selecting the photo.

## 0.35.3

### Patch Changes

- 726d997: Make lightbox Fill consistently use window width for portraits and window height for landscapes.
- 95d99f8: Show pending library moves as blocked during the move Review step.

## 0.35.2

### Patch Changes

- 486360e: Resume interrupted library moves after verifying staged files instead of restarting large copies from zero.
- d748815: Prevent a fresh library move from orphaning an interrupted move's resumable staged copy.
- 4fe704f: Allow dragging the lightbox window from blank toolbar space while keeping its controls interactive.
- 932251d: Preserve lightbox zoom, fill, and normalized pan while navigating between photos.

## 0.35.1

### Patch Changes

- 57b75ae: Fix photo tile and list-row controls so open, selection, and status semantics remain accessible.
- fd7deae: Expand compact sidebar and photo-selection hit areas to the WCAG 2.2 24px minimum without enlarging their visual glyphs.

## 0.35.0

### Minor Changes

- 71ffe34: Hide every lightbox overlay when the displayed image or empty full-view space is clicked, and wake the controls on pointer, keyboard, or focus activity.

### Patch Changes

- b048589: Keep Settings at a stable bounded size while provider data loads, scroll only its active content pane, and animate dialog entry and exit with reduced-motion support.

## 0.34.2

### Patch Changes

- 66404bf: Clarify sidebar storage with separate on-disk and provider-specific offload totals.

## 0.34.1

### Patch Changes

- d3f54af: The Move Library wizard's Review step now dry-runs the ADR-0022 preflight per library before anything moves: an honest method chip (INSTANT MOVE vs COPY & VERIFY), a destination space meter with exact needed-vs-free bytes, the network-volume warning (which never blocks), and inline refusal copy that disables Start for real blockers while name collisions simply note the numbered-name fallback.

## 0.34.0

### Minor Changes

- c91f362: Move library… wizard (ADR-0022, #483): the library switcher gains per-row Move actions and multi-select, opening a Review → Progress → Results wizard over the relocation service — collision-safe destination folders under a chosen root, sequential batch moves with the open library last, live item/byte progress, a cancel affordance that changes honestly once a move commits, and results that report exact bytes, unchanged library IDs, and the both-copies cleanup-pending state with a safe retry. A resume banner surfaces committed moves whose source cleanup is still pending after a crash.
- 5653b24: Relocation hardening (ADR-0022, #483): preflight now classifies the destination volume for real — FAT32 refuses with an actionable message (its 4 GB file cap would truncate large originals) and network mounts are flagged as a warning, never a block (ADR-0017 §5). A new `library-relocation:preflight` dry-run channel powers the wizard's Review step (resolved move method, exact byte requirements vs. free space, network warning, source-lock holder) without taking locks or writing journals. Electron E2E now proves the ADR-0022 §4 crash matrix end to end: killed at every copy/verify/activate/commit boundary, relaunch recovery leaves exactly one authoritative, usable library.

### Patch Changes

- 7049599: Relocation fixes from PR #553 review: a successful active-library move now rebinds the runtime to the destination (same-id select refreshes the cached registry entry instead of serving the stale source path), and moving an app-locked library no longer fails verification — the staged-custody probe recognizes ADR-0013 OVLK custody and skips the passwordless open probe, relying on the byte-digest verification that already proved the copy identical.

## 0.33.0

### Minor Changes

- 9fef102: Journaled library relocation service and IPC (ADR-0022, #483): new `library-relocation:*` channels move a registered library with a copy → verify (SHA-256 + staged-DB custody check) → atomic registry commit → cleanup protocol; moving the active library quiesces it through the full teardown contract and reopens it at the destination (or, on any pre-commit failure, at the untouched source). Startup now settles relocation journals before opening a library — resuming committed cleanups, discarding marker-bound staging, and rolling forward a crash caught between the registry rewrite and the journal advance. Failure before the commit always leaves the original registered and usable; a cleanup failure after the commit reports both verified copies and offers a safe retry, never guessing which to delete.

## 0.32.5

### Patch Changes

- 516f490: Keep shell notifications positioned clear of the status and control bars.

## 0.32.4

### Patch Changes

- e6b7386: Raise faint-text and destructive-action colors to meet WCAG AA contrast across every resting app surface.
- de4799e: Require accessible names for switches, progress bars, and checkboxes.
- a5a3872: Prevent macOS file drops from locking input, navigating the app, or opening blank windows.
- d854fc6: Confirm pCloud disconnects and keep credential removal reliable, observable, and persistent across restarts.
- 1fdf50f: Keep toast actions reachable and pause timed dismissal during interaction.
- 5d0a5dd: Decode HEIC photos into oriented thumbnails and full-resolution previews on macOS while preserving byte-faithful encrypted originals.

## 0.32.3

### Patch Changes

- 42ee689: Reuse retained legacy `photos` profiles after reinstall so local libraries and provider connections remain available, let fresh-profile onboarding open an existing library without downloading a cloud backup, and preserve the previous library if failed restore activation recreates a partial target directory.

## 0.32.2

### Patch Changes

- 93dfa9b: Hide offloaded-original restore controls until the backup provider connection check resolves.

## 0.32.1

### Patch Changes

- baadd2c: Show a neutral loading state while checking the selected backup provider instead of briefly rendering it as disconnected.

## 0.32.0

### Minor Changes

- c27e84f: Import user-selected photos from Google Drive through the secure system-browser Picker and the existing encrypted import pipeline.

### Patch Changes

- 7310905: Production release hardening and licensing compliance.

  - Minify main/preload/renderer bundles, emit no source maps, and enable Electron
    production fuses (runAsNode off, cookie encryption, NODE_OPTIONS/`--inspect`
    ignored, onlyLoadAppFromAsar + embedded asar integrity validation).
  - Add the `license` field, generate and ship `THIRD-PARTY-NOTICES.md` for the
    shipped dependency closure, and bundle it plus `LICENSE` into the packaged app.
  - Add a `lint:licenses` policy gate (SPDX allowlist + reviewed exceptions),
    notices-freshness check, and a CycloneDX SBOM release artifact.

## 0.31.2

### Patch Changes

- eb1af86: Add the biometric usage description and verify the final provisioned macOS app's embedded profile and signed Touch ID identity.

## 0.31.1

### Patch Changes

- 45deb06: Authenticate Google Drive token exchange and refresh with the generated credential required by the issued Desktop OAuth client.

## 0.31.0

### Minor Changes

- 227f312: Keep settings, provider selection, remote backup homes, decrypted caches, protected-album authorization, import recovery, and offload custody isolated to the active library across live switches.

## 0.30.0

### Minor Changes

- 03708be: Library switcher UI (#386): the titlebar now names the current library and opens the switcher — a modal listing every registered library with its state (open now, available, missing volume, locked by another computer), live switch on click or keyboard (↑↓/⏎), a create flow with location picker, add-existing registration, and registry-only removal with reassurance copy. Switch refusals (backup running, locked, target locked elsewhere or missing) surface as typed inline banners instead of opaque errors.

### Patch Changes

- 3c5d75a: Keep dense photo grids responsive when unavailable thumbnails enter the viewport by avoiding a React rerender for every image load failure.

## 0.29.1

### Patch Changes

- ba59725: Fix Google Drive desktop authorization to use Google's documented root loopback redirect and show bounded, credential-redacted provider error details when token exchange or refresh fails.

## 0.29.0

### Minor Changes

- 27d77db: Safe library switching and crash-safe lifecycle (ADR-0017 §4/§5, #385): opening another library from the registry now performs a live switch — full teardown (imports cancelled to their journal, backups aborted to the sync ledger, purge drained, WAL checkpointed, keys zeroed), app-lock re-pointed at the new library, and a fresh renderer. Ordinary quits run the same teardown, each library carries an advisory single-instance lock (stale locks from crashes are reclaimed), a second app instance per profile hands off to the first, creating a library provisions its empty database, and a registered library whose directory is missing fails loud instead of being recreated empty.

## 0.28.0

### Minor Changes

- 20f4537: Migrate signed macOS builds to `com.zts1.overlook` while preserving the existing Overlook profile, app-lock anchor, library, provider custody, and recovery data. Existing Touch ID enrollments from the former app identity now require an explicit password-confirmed re-enrollment.

## 0.27.1

### Patch Changes

- 9a751c0: Add local diagnostics review, exact JSONL export, and deletion controls while keeping transmission disabled.
- bb1014d: Remove unused renderer fetch privileges from the thumbnail protocol while preserving full-image prefetch support.
- 5f3a095: Add a strict privacy-safe diagnostics contract, encrypted bounded local custody, and versioned consent that never upgrades the former local-only preference silently.
- c902d1a: Make Lightbox Fill cover both viewport axes while keeping overflow pannable across viewport and Inspector size changes.
- f795f92: Keep unlocked protected albums authorized while navigating within the active unlocked app session.
- 7e6fb3c: Capture only allowlisted main, renderer, and child process-health signals into the consent-gated encrypted local diagnostics queue.
- b75dbbc: Keep Lock when hidden from firing during macOS native full-screen transitions while preserving genuine hide and minimize locking.
- adb955c: Scrub main-process IPC failures to opaque renderer-safe error codes while retaining details only in main-process logs.
- 13876a7: Style the Transfer & Sync Settings action with the shared primary button.

## 0.27.0

### Minor Changes

- afe6cb6: Multi-library registry and per-library key management (ADR-0017, #384): the library path is now resolved through a standalone `libraries.json` registry (existing installs are registered in place with no data movement), each created library provisions its own master key and KEY #1 in its own directory, and new `library-registry:*` IPC channels expose list/create/open/remove/current to the renderer. Removing a library from the registry never touches its data or keys.

## 0.26.1

### Patch Changes

- bd9e602: Restore the lightbox orientation toolbar with view-only rotate, flip, and reset controls.

## 0.26.0

### Minor Changes

- 70cdf01: Library search now runs on the FTS5 index (`photos_fts`) instead of a plain substring scan: prefix-matched per word and ranked by bm25, overriding the grid's date/name/size sort while a search is active. A query with no tokenizable content (pure punctuation/whitespace) falls back to the previous substring match. Startup maintenance also verifies the search index's integrity and rebuilds it if it's drifted from the photos table.

## 0.25.3

### Patch Changes

- 5d9cfdf: Render and repair encrypted previews for every accepted RAW photo format.

## 0.25.2

### Patch Changes

- 512c6f4: Keep large Finder photo batches in one Overlook window and import dropped folders recursively.

## 0.25.1

### Patch Changes

- b79e7ca: Repair missing JPEG dimensions from decoded pixels so metadata-lite imports and existing 0×0 photos render correctly without changing original bytes.

## 0.25.0

### Minor Changes

- 65615ae: Add independent protected-album passwords, migration ceremonies, session-only unlock and relock, recovery, and leakage-proof protected photo browsing.

## 0.24.1

### Patch Changes

- 407a707: Add an executable cross-product interoperability acceptance and release-evidence gate.

## 0.24.0

### Minor Changes

- 0c8e98d: Add truthful Image Trail Transfer and Sync entry points plus review, conflict, progress, recovery, provider, pairing, and unavailable-original states.

### Patch Changes

- 71bd82e: Restore launchable macOS releases by requiring a matching provisioning profile for restricted Touch ID entitlements and smoke-testing the packaged artifact.

## 0.23.0

### Minor Changes

- cf96f5c: Add direct photo and selection drag-and-drop organization between albums.
- db88013: Add durable deterministic Sync journals with replay-safe conflict and reviewed-delete decisions.
- e3addd2: Enforce protected-album isolation at main-process query, media, and action boundaries.
- 6582858: Back up, verify, restore, offload, and rehydrate protected-album ciphertext without disclosing protected metadata to cloud providers.
- 26d9e73: Add provider-neutral encrypted interoperability transport and the fail-closed signed iCloud bridge boundary.

## 0.22.0

### Minor Changes

- f081192: Add accessible album rename, delete, and remove-membership workflows.
- 589622b: Add Google Drive as an encrypted backup, offload, and disaster-recovery provider.
- d870623: Add crash-safe, domain-isolated migration custody for protected album photos and derivatives.

### Patch Changes

- 566ad50: Ship Windows packages without compiling the macOS-only Touch ID bridge.

## 0.21.0

### Minor Changes

- a68b86e: Add crash-safe acknowledged Move journals that preserve source originals until target metadata and byte custody are verified.
- 5dae313: Add opt-in native Touch ID unlock on supported signed macOS builds while preserving app-password fallback and fail-closed key custody.
- 5dbbe39: Add the protected-album key-slot, sealed-metadata, and session-authority foundation.

### Patch Changes

- 2cce89b: Keep the root application releasable after adding the local Touch ID native dependency.

## 0.20.0

### Minor Changes

- 74eb06f: Translate and persist Image Trail bookmarks and albums without fabricating native photo metadata.
- 57b8336: Publish the canonical Overlook and Image Trail interoperability contract.

## 0.19.0

### Minor Changes

- 6f122e7: Add a main-process-enforced app password, locked startup and lifecycle triggers, persisted retry throttling, crash-safe credential rotation, recovery-key re-establishment, fail-closed work teardown, and dedicated lock and Privacy settings surfaces.
- 7cda42c: Add orientation-aware lightbox fill, clamped two-axis panning, focal-point zoom from 0.25× to 8×, and accessible zoom/reset controls.

### Patch Changes

- bb473c7: Keep background prefetch and export reads temporary when re-offload-after-viewing is disabled, and prevent an offload-in-progress lightbox from immediately fetching the evicted original again.

## 0.18.0

### Minor Changes

- 8b19085: Add verified temporary viewing and export custody for cloud-only originals, with a default-on re-offload policy and an explicit Keep downloaded action.

## 0.17.0

### Minor Changes

- e05eb99: Add verified manual offload controls to selections, photo context menus, and the lightbox, with exact preflight results, responsive actions, Undo, and Settings controls to restore selected or all offloaded originals.

## 0.16.2

### Patch Changes

- 1ae24a6: Audit existing cloud backups in bounded resumable batches, repair missing or corrupt ciphertext when a local encrypted original remains, surface unrecoverable remote-only loss, and regenerate damaged recovery metadata.

## 0.16.1

### Patch Changes

- 5f81f4d: Hide incomplete and empty pCloud backup folders from restore discovery while preserving completed recovery libraries.

## 0.16.0

### Minor Changes

- cf1914a: Add provider-neutral cloud-library discovery and a staged restore workflow in fresh-profile onboarding and Settings.
- 9ac6aa8: Add provider-addressed cloud selection, explicit capability reporting, safe switching, and provider-neutral backup UI.

## 0.15.0

### Minor Changes

- dc788ec: Add a provider-neutral disaster-recovery engine that resumes authenticated staging, rebuilds encrypted library state, and atomically activates or rolls back a restored cloud library.

### Patch Changes

- 7dc783a: Keep the loaded gallery, selection, and lightbox stable while cloud backup updates photo sync status.

## 0.14.0

### Minor Changes

- a7cd8ef: Add a complete encrypted backup manifest and recovery-key bootstrap so cloud backups contain the provider-neutral metadata and wrapped keys required for disaster recovery.

## 0.13.2

### Patch Changes

- e279f66: Edits now back up themselves: favoriting, album changes, and restores trigger the same quiet auto-backup imports use (when "Back up new imports automatically" is on), so the "ENCRYPTING → PCLOUD" indicator no longer sits until a manual backup.
- 3a4583c: Editing an offloaded photo (album add, favorite) no longer breaks the backup run: its blob is already remote, so the edit rides the next manifest generation and the pending indicator settles without re-uploading anything.

## 0.13.1

### Patch Changes

- 0d8c06e: Fix pCloud sign-in: v0.13.0 shipped with an incorrect OAuth client id, so Connect failed at the authorize step.

## 0.13.0

### Minor Changes

- 83f1d84: pCloud is now the storage provider in packaged builds (#109): Connect in Settings → Storage & Backup opens a pCloud sign-in in the browser, and backup, verify, offload, rehydrate, and the quota card run against the live account. Backups upload under `/Overlook/<library-id>/`, encrypted end-to-end — pCloud only ever sees ciphertext. Dev and test builds keep the local mock provider.

## 0.12.2

### Patch Changes

- b79a874: Provider connect/disconnect now runs through the backup service (`backup:connect` / `backup:disconnect`) instead of a bare settings patch — groundwork for pCloud sign-in (#254). Mock-provider behavior is unchanged; disconnecting now also drops any stored pCloud credentials.

## 0.12.1

### Patch Changes

- 9f8f7dd: macOS builds are now signed with a Developer ID certificate and notarized by Apple; tagged releases publish as full releases instead of unsigned pre-releases (#128). Windows builds remain unsigned pending a certificate.

## 0.12.0

### Minor Changes

- 27d8dd9: Disconnecting pCloud now hides every backup surface instead of showing misleading states: the toolbar backup button disappears, the status bar reads "PCLOUD NOT CONNECTED", the sidebar backup card drops the progress/pCloud figures for a local-only line with a Connect link, and Settings → Storage & Backup hides the backup-specific controls (import Copy/Move stays usable — it needs no provider). Everything restores live on reconnect.
- 6817953: Import is no longer SD-only: the Import dialog gains a source picker — SD card (with a "no card detected" empty state), Local folder (OS picker, scans subfolders), and Dropped (drag photo files anywhere onto the window for a full-window drop overlay that opens the dialog pre-seeded). Move remains exclusive to SD cards: folder and dropped imports force Copy in the UI and the pipeline rejects Move for non-volume sources, so the app never deletes a user's own files. Non-photo drops get a "nothing to import" toast.
- 4a7093b: Recovery key backup and import (Settings → Privacy): export the library's master key as a password-encrypted `overlook-recovery.key` (scrypt + AES-256-GCM, password + confirmation with a strength meter and an explicit cannot-be-reset acknowledgment), and import a `.key` file on another device to unlock a restored library. Install validates the key against the library's stored key rows and never overwrites working custody it can't vouch for; wrong passwords fail closed.

## 0.11.0

### Minor Changes

- 1024f75: Collapsible sidebar: a toggle collapses the navigation to a 56px icon rail — labels and counts move into right-side tooltips, section headings become dividers, and the backup card becomes a shield button that opens Settings. The collapsed state persists across launches. Tooltips now support all four sides and position with fixed viewport coordinates so overflow ancestors can't clip them.

## 0.10.0

### Minor Changes

- 7267943: Real app icon and brand wordmark: packaged mac/win builds now carry the gradient-ringed hexagon product icon (generated from the design handoff icon set), dev runs set the dock/taskbar icon, and the toolbar wordmark is the icon beside "OVERLOOK" filled with the brand gradient (replacing the placeholder aperture glyph).

## 0.9.0

### Minor Changes

- 2e423e6: Brand palette refresh: the primary accent is now the blue-violet iris (`--accent-iris`, matching the new app icon); `--accent-cyan` and `--accent-cyan-dim` are legacy aliases resolving to iris, so selection, focus, primary actions, and active nav all adopt the new hue. Adds `--accent-cyan-bright` / `--accent-violet` gradient ends and the `--brand-gradient` / `--brand-gradient-soft` tokens for brand moments.

## 0.8.1

### Patch Changes

- 35afd9c: Security review (#129): adversarial audit of the crypto envelope/keystore, the IPC registry + custom protocol handlers, and a plaintext-at-rest sweep. All three seams verified sound against the ADR-0004 threat model — no fix-before-release findings. Hardening fix (F1): the test/dev harness env hooks (`OVERLOOK_SEED`, `OVERLOOK_SEED_SYNTHETIC`, `OVERLOOK_IMPORT_SOURCE`, `OVERLOOK_EXPORT_DESTINATION`, `OVERLOOK_BACKUP_FAULT`, `OVERLOOK_USER_DATA`) are now honored only in unpackaged builds via a single `harnessEnv()` gate, matching the existing `OVERLOOK_INSECURE_KEYSTORE` posture — a packaged app can no longer be steered via env. The written review and ADR-0004 accepted-deviation notes live in the wiki; follow-up hardening is tracked in #229 (per-key nonce budget), #230 (central IPC error scrubber), and #231 (protocol least-privilege polish).

## 0.8.0

### Minor Changes

- f7ed6d5: Crash-safety audit (#125): a ConsistencyChecker detects DB↔blob↔ledger drift (orphan blobs/thumbs, staging leftovers, rows lying about a local original) and repairs what is safe — remote-verified missing blobs become `offloaded` (rehydratable), truly lost blobs become `error` (the red glyph is the honest prompt), orphans and staging strands are removed. A lightweight repair runs at library open. The kill-test matrix consolidates: per-stage import resume (existing), backup mid-upload/mid-verify resume (existing), plus new offload and purge crash-window tests and a deliberately-corrupted-store-repairs-to-consistency proof.

### Patch Changes

- 589e5d0: Coverage-map completeness sweep (#126): the design README's full screen/interaction inventory audits against the acceptance ledger — 30 automated entries, one manual-with-reason (visual motion/hover/disabled rules), and two deferred-with-issues for the not-yet-designed set (semantic search results #224, album reordering #225). Distribution recorded in the wiki Testing-Strategy.
- d4498f0: Perf tuning to budget (#124): sidebar counts run as ONE FILTER-clause pass over the ledger join instead of five separate counts (689ms → 378ms at 200K; ratchet tightened to 500ms), with the offloaded predicate now join-based so page() and counts() still share one where-clause truth. Zoom-96 scroll drops stay within budget; the disk-cache lever is rejected on privacy grounds (decrypted thumbs never hit disk — ADR-0004, recorded).

## 0.7.1

### Patch Changes

- e0956dc: Perf harness + budgets (#123): the 200K target becomes measurable — `npm run test:perf` (own Playwright config, never a per-PR gate; manual CI lane via perf.yml) measures cold-start-to-grid, IPC query latency medians (page/counts/search), scroll frame-drop rate at the three design zooms, full-pipeline import throughput, and memory ceilings, writes `perf-report.json`, and asserts the ratchet budgets in `tests/perf/budgets.ts` (recorded with baselines in the wiki Testing-Strategy).

## 0.7.0

### Minor Changes

- 4106eb1: Add to album from the selection pill (#118): a picker popover anchored above the pill lists existing albums with live counts and creates one inline (Enter commits, Escape closes); picking adds the whole selection with the exact-count toast ("Added 12 photos to Big Sur"). Removing from an album stays a follow-up — the design is silent on the album-context action (noted on the epic).
- 65ec43e: Albums CRUD (#117): create/rename/delete albums and add/remove membership over typed `album:*` IPC — deleting an album never deletes photos (Clear-vs-Delete rules) and every album edit dirties the affected photos for the next manifest (ADR-0007). The sidebar Albums section goes live: inline create from the + affordance, live counts, and an album as the active source filtering the grid (`library:page` gains `albumId`).
- 1ff13dd: Permanent purge with retention (#121): the trash pill's destructive Delete opens the confirm ceremony (red button, exact counts, "This can't be undone.") and removes all three copies — DB row first (the local state never lies), local blobs, remote last with retries. A failed remote delete is audited as a repairable ORPHAN-REMOTE (surfaced as an amber "CLOUD COPIES PENDING" toast), shared-hash blobs survive while any row still owns them, and purging owes the remote a fresh manifest generation. Soft-deleted rows auto-purge after 30 days — a fixed constant until a settings control is designed (recorded).
- ec6bfc2: SettingsDialog shell (#112): the design's 640px two-pane frame — 160px icon+label left nav (General / Storage & Backup / Privacy, Storage & Backup default-open), placeholder panes until the sections land, opened from the sidebar gear (which stops stub-toasting).
- 97bae4e: Settings — General section (#113): default sort order (Date / Name / Size) wired to the store and the grid query — a change re-orders the grid live and persists; appearance segmented with Light disabled ("dark only for now" — the DS has no light theme); thumbnails-on-import locked on with its rationale. The library page query gains a keyset-safe `order` parameter (date newest-first, name A→Z, size largest-first).
- 2952418: Settings — Privacy section (#115): end-to-end encryption row with the always-on badge and factual copy, face grouping shipped disabled as "not yet available" (the mock's locked-on state is deferred by design — not faked), and the share-diagnostics switch (off by default, anonymous-only copy; the preference persists while reporting stays local-only).
- a633f83: E2E (#116): settings persist across a real app restart — run one changes sort/Wi-Fi/bandwidth and disconnects the provider, run two proves the store reports them, the grid renders in the persisted order unprompted, the dialog re-renders the disconnected state, and manual backup stays blocked. Also fixes a toast race the suite surfaced: an automatic backup's green "BACKUP COMPLETE" was replacing the import-complete toast — auto successes are now quiet (the status bar still flips); manual runs keep the toast and failures stay loud for every trigger.
- 5520033: Settings — Storage & Backup section (#114): provider connection card (badge, live quota bar from the provider, Connect/Disconnect driving `providerId` — mock connects instantly, live pCloud arrives with #109), auto-backup switch, shared Copy/Move on-import segmented (the ImportDialog now opens with and persists the same setting), Wi-Fi-only switch, bandwidth slider (Unlimited at 100), locked "Encrypt originals". All backup controls disable when disconnected, and a disconnected provider suppresses auto-backup-on-import.
- 3da6b11: Typed settings store (#111): zod schema with design defaults, atomic JSON persistence in userData with per-key corrupt recovery, `settings:get`/`settings:set` IPC plus `settings:changed` pushes. The backup engine now reads throttle/Wi-Fi/auto-backup live from the store, and auto-backup-on-import is active (default on, per the design).
- 73738be: Soft delete (#120): Delete is safe by default — the selection pill's Delete and the lightbox trash button move photos to the Recently deleted source (blobs, ledger, and album membership untouched), where the pill flips to Restore. Deleted rows leave pendingCount and the upload queue; restore brings favorite/EXIF/ledger status back intact and re-dirties the row for the next manifest. Permanent purge is #121's destructive ceremony.

### Patch Changes

- 59719d8: Backup story proven in CI (#110): edit-re-dirties, the offload → lightbox
  rehydrate round-trip, and a fault-injected upload failure surfacing the red
  retry toast + error glyph — via the new OVERLOOK_BACKUP_FAULT harness hook.
  Wi-Fi/throttle honoring stays deterministically covered at the engine
  integration layer until M09's settings pane exposes it live.
- c60b2cd: Source truth (#119): sidebar counts now share `page()`'s per-source where-clauses — one query truth, so counts and grid results cannot drift by construction. A property-style suite pins it: for every source, count === full keyset page-walk total; chips AND with sources ('Local only' means ledger-local, contradictions yield the empty set honestly); deleted rows stay invisible outside the trash.

## 0.6.0

### Minor Changes

- 7d0437f: Backup UI (#108): every design surface goes live off engine events — the
  toolbar backup button triggers the run with the mock's amber/green toast
  pair, the StatusBar's amber "ENCRYPTING n" counts down live and flips to
  "ALL BACKED UP · JUST NOW" off the real stamp, per-photo glyphs ride the
  targeted pushes, and the sidebar card shows the aggregate progress bar plus
  the real LOCAL · PCLOUD storage split.
- 4a4f67d: Offload + rehydrate (#107, ADR-0007): verified-synced originals evict
  locally (thumbnails stay — the library browses offline) with a shared-hash
  guard, flipping tiles to the offloaded state via targeted pushes; touching
  an offloaded photo in the lightbox downloads it back through an atomic
  staged restore that decrypt-and-rehash verifies before publishing — a bad
  download never becomes local truth and failures surface as a red toast.
  Library stats gain the local/cloud byte split, and `backup:offload` /
  `backup:rehydrate` channels expose the flows.

## 0.5.0

### Minor Changes

- 61d8168: Backup engine (#105, ADR-0007): the ledger's dirty set flows to the provider
  as a resumable queue — ciphertext uploads byte-for-byte (encrypt-once), an
  encrypted manifest generation seals per batch (N=2 retained), transient
  failures retry with exponential backoff while auth/quota stop the run, the
  bandwidth throttle rests proportionally between items, the Wi-Fi-only gate
  skips metered networks ('unknown' proceeds as the recorded heuristic), and
  auto-backup-on-import subscribes to the import events. New `backup:run`
  channel and `backup:progress` events for #108's UI.
- 2201afa: Verify-after-upload (#106, ADR-0007): "backed up" is never a lie — the
  engine hashes the local ciphertext and compares sha256+size against the
  provider's checksum before a row may go synced; mismatches go `error` and
  stay dirty (re-queued next run), with every verify result appended to the
  backup audit log. Status changes push targeted library updates so tiles
  flip to the cloud-alert glyph live, and failed runs raise the red toast
  with a Retry action via the new `backup:completed` event.
- b3e3dac: Storage-provider seam (#103, ADR-0007): the typed interface the whole backup
  epic builds against (put/getStream/list/delete/quota/verify + auth state,
  typed ProviderError kinds), a filesystem-backed mock provider with quota and
  connection simulation, a fault-injection wrapper producing every engine
  error path (upload failure, verify mismatch, auth expiry, transient
  download), and a provider registry whose connection states feed the
  settings card. Live pCloud arrives as #109 against the same contract suite.
- c3df7ff: Sync-ledger status machine (#104): the ledger vocabulary gains `error`
  (migration v2 rebuilds the table), transitions are machine-validated
  (illegal ones throw), every library edit dirties through ONE choke-point,
  verified completion clears dirty and stamps `last_backup_at`, and the
  status bar's backed-up label now reads the real stamp ("JUST NOW" /
  "2H AGO", "NEVER" before the first backup). Inspector renders the error
  state ("SYNC FAILED — WILL RETRY").

## 0.4.0

### Minor Changes

- 9546ff4: ExportDialog (#99): the design's 420px export flow with the safety copy
  verbatim — selected-count row, Original/JPEG segmented, "Decrypt originals"
  on by default (off disables Export and shows the amber warning; v1 ships no
  encrypted-export format), destination via the OS folder picker, a single
  progress bar labeled by decrypt state, and a done summary that honestly
  notes preview-capped RAW transcodes.
- be49c3d: Export entry points (#100): the selection pill's Export action goes live
  (dialog opens with the exact selection count, selection preserved through
  the flow) and the lightbox share icon opens the dialog with count=1 for the
  focused photo, replacing the M07 stub toast.
- c610ccd: JPEG transcode export (#98): `format: jpeg` produces universally-openable
  files via sharp at quality 90 — RAW sources transcode from their embedded
  preview (v1 policy) with the preview-capped count surfaced in the summary,
  filenames re-extension to .jpg under the same collision policy, and
  metadata is STRIPPED on transcode per ADR-0006's privacy stance (camera
  identity and GPS travel only when exporting originals).

### Patch Changes

- bd4b9bf: Export proven end-to-end in CI (#101): the OVERLOOK_EXPORT_DESTINATION
  harness hook mocks the OS folder picker for the acceptance flows — select 3
  → pill Export → 3 decrypted files on disk, and a full-circle import-a-RAF →
  lightbox-export-as-JPEG run exercising the preview policy.

## 0.3.0

### Minor Changes

- 0f1fb01: Export engine (#97): selected photos become real files in a chosen folder —
  streaming decrypt straight to the destination with original filenames
  (collisions get a recorded numbered suffix), free-space preflight before any
  bytes move, ordered n/total progress events, and cancellation that finishes
  the file in flight and keeps completed files. New `export:*` IPC surface
  (pick-destination via the OS folder picker, run, cancel, progress). v1 ships
  no encrypted-export format — the dialog's decrypt-off switch will simply
  disable Export (recorded on #97).
- ff70239: ImportDialog (#88): the design's 420px import flow over the real engine —
  options (scanned source card with mono counts, Copy/Move with the verbatim
  Move warning, always-on encrypt switch, exact "Import N photos" count),
  running (two live ProgressBars fed by the engine's copy and thumbnail
  streams), done ("Show in library" jumps to Recent imports). The toolbar's
  Import button now opens it against the first available source.
- 372a47a: Import flow closed out (#90): the full path is proven end-to-end in CI —
  fixture card in (via the `OVERLOOK_IMPORT_SOURCE` harness seam), encrypted
  library out, with no plaintext fixture bytes anywhere in the profile and
  Move sources emptied only after per-file verification. The running dialog
  gains a real Cancel (`import:cancel`): the engine finishes the file in
  flight, keeps everything completed, finalizes the remainder as cancelled
  (sources untouched), and reports exact counts.
- e24a33d: Inspector (#94): the 280px right-docked truth panel — header with thumb,
  name, date · place and StatusGlyph; Encrypted/RAW-JPG/Favorite badges;
  grouped Capture/File/Backup MetadataRows with interpunct-joined mono values.
  Missing EXIF rows are omitted (never fabricated), the backup row states only
  what the ledger knows, and the cipher row reads the photo's real key id. In
  the lightbox the overlay yields the right rail so the panel docks beside the
  photo; in the grid it reflects a single selection.
- 028a728: Lightbox keyboard (#93): ←/→ step the visible filtered sequence with
  wraparound via a pure reducer action shared with the on-screen arrows,
  neighbor prefetch now fires on every lightbox change (keys or clicks),
  i/I toggles the Inspector, and Esc keeps its dual semantics — all without
  clicking to focus.
- 58bc8a4: Lightbox mutations (#95): the favorite toggle is proven end-to-end — ledger
  dirties (pendingCount), StatusBar flips amber with exact counts, and the
  grid tile's star appears via targeted change pushes with no reload. The
  delete control is explicitly labeled as the M10 soft-delete seam.
- 1c676a9: Lightbox (#92): full-window image-first view over the decrypt-to-view
  delivery layer — aspect-fit photo via `overlook-full://`, PREVIEW badge on
  RAW records, top bar (back/favorite/export/inspector/delete), side arrows
  with wraparound and neighbor prefetch, EXIF strip on the protect-gradient,
  and chrome that fades in on mousemove and auto-hides after 2.2s idle.
- 74c80e4: Import completion toast (#89): a clean import shows the green "Imported N
  photos" toast (exact counts) with a Show action that jumps to Recent imports;
  toasts now auto-dismiss at 4s per the design's ToastHost. The toast action is
  a serializable marker in the shared reducer, mapped to its handler by the
  shell.

### Patch Changes

- 351aff8: Lightbox chrome can now actually auto-hide while the pointer rests on it:
  Chromium re-dispatches a synthetic mousemove when the fade's pointer-events
  flip changes hit-testing under a stationary cursor, which re-woke the chrome
  in a loop. Stationary events are now ignored; only real movement wakes.

## 0.2.0

### Minor Changes

- da48b62: App state store and composition shell: a pure reducer holds the mock's app
  state (query, zoom, view, source, chips, selection, lightbox, inspector,
  dialogs, toast, pending count), provided to the renderer via context with IPC
  push events dispatching into it. The app now boots into the composed chrome —
  title bar, toolbar region, sidebar with live source counts, content region,
  optional inspector, and status bar — with global keys (⌘/Ctrl+A, Esc, `i`)
  wired through the reducer.
- faf5d94: Encrypted blob store: content-addressed originals and thumbnails under the
  library layout — every byte streams through the AES-256-GCM envelope before
  touching disk (staging included), writes land by fsync + atomic rename,
  reads decrypt by key id, and a verify walk re-checks every auth tag plus the
  content address. Orphan scanning backs the future repair story.
- 3e3b78c: Core design-system controls land: Button (primary/secondary/ghost/danger,
  sm/md/lg), IconButton (with active tint), Badge (five tones, uppercase mono
  pill), and Tooltip (top/bottom, 200ms fade) — pixel-matched to the design
  specimen card, tokens only.
- 718875a: Crypto engine: streaming AES-256-GCM envelopes per ADR-0004 — 4 MiB chunks
  with per-chunk auth tags, AAD binding photo id / key id / chunk index, a
  truncation-detecting final marker, and key-versioned decryption. Tamper,
  reorder, truncation, wrong-key, and wrong-context all fail loudly.
- 1610701: Design tokens land in the renderer: the five Overlook token files (colors,
  typography, spacing, elevation, fonts) become the styling source of truth,
  IBM Plex Sans/Mono bundle locally (OFL), and the shell renders a token
  specimen page (neutrals, accents + dims, type scale).
- c2327e8: Deterministic dev seed: `npm run seed:dev` fills an empty library with
  mock-shaped, envelope-encrypted sample photos and the four design albums
  through the real crypto/blob/database path; E2E boots seeded fresh temp
  profiles via OVERLOOK_USER_DATA/OVERLOOK_SEED, and a metadata-only synthetic
  variant backs future 200K perf work.
- 67ad989: Electron desktop shell scaffold: `npm run dev` opens a window rendering the
  React shell placeholder. Main/preload/renderer processes exist with security
  defaults (no nodeIntegration, contextIsolation, sandboxed renderer);
  `npm run build` now produces the app bundle in `out/` via electron-vite.
- d2bee22: EXIF extraction for the import pipeline: exifr (pure JS per ADR-0006) behind
  a pure module producing the Inspector's field set — camera (make+model,
  deduped), lens, ISO, aperture and shutter formatted like the mock, focal
  length, dimensions, taken-at, GPS coordinates per the ADR privacy stance.
  RAF files resolve their embedded JPEG via the documented header offsets;
  missing or corrupt metadata degrades to an all-null record — never an
  exception, never a fabricated value.
- 8a9d4af: Feedback and media primitives: ProgressBar (4px animated track, three
  tones, mono counters), StatusGlyph (the five sync states with the design's
  labels in a blurred capsule, spinning while syncing), and MetadataRow
  (uppercase-mono label + truncating value) — the pieces import, backup, and
  inspector surfaces consume.
- 430131d: Frameless window chrome: macOS uses native traffic lights over a hidden-inset
  title bar, Windows/Linux run frameless with minimize/maximize/close driven
  over typed IPC. The window enforces a 960×600 minimum, paints the design's
  near-black background before first render, and the renderer's top 30px strip
  drags the window.
- 252224d: Full-resolution decrypt-to-view delivery (#91): `overlook-full://` serves
  originals decrypted in memory under a byte-capped LRU (configurable via
  `OVERLOOK_FULL_CACHE_MB`), with `Cache-Control: no-store` keeping plaintext
  out of Chromium's disk cache. RAW records resolve to their viewable embedded
  preview (by magic, per ADR-0006) with an `X-Overlook-Preview: 1` marker, and
  `?prefetch=1` warms neighbors for stall-free lightbox paging.
- 7309475: The grid becomes real: virtualized cells render PhotoTiles fed by the page
  data — thumbs over the decrypting protocol, favorite badge, sync-status glyph
  (the page query now joins the sync ledger so every photo carries its sync
  state), select circle vs open click, and live zoom from the toolbar slider.
  An impossible filter or empty library shows the mock's "Nothing matches"
  empty state. Under active search/chip filters the scroll plane tracks the
  loaded count until exact filtered totals land with the toolbar work.
- f752de0: Import engine (#87): source files become encrypted, verified library records
  through a per-file pipeline (hash → skip-if-known → encrypt-stream → EXIF →
  single-transaction record with a dirty sync-ledger row → thumbnails), driven
  over the new `import:run` channel with two aggregate progress events
  (copy+encrypt and thumbnails). A staging-manifest journal makes every batch
  interruptible: a relaunch resumes idempotently, and Move deletes each source
  file only after that file's blob passes a full decrypt-and-rehash
  verification — per file, never end-of-batch.
- 92ad475: Import sources (M05 begins): removable-volume enumeration (macOS /Volumes,
  Windows drive letters, udisks mounts on Linux) plus the manual folder path,
  and a media scan producing the design's source-card numbers — total, NEW via
  full-file SHA-256 presence against the library (the blob store's own content
  address, so a re-scan after import reports zero new), RAW/JPG split, and
  bytes — with progressive counts pushed for big cards over the new
  `import:list-sources` / `import:scan-source` channels.
- 2ba3dc9: Input form controls: Slider (value-tracking fill, proper stylesheet thumb),
  Switch (real switch role, locked-on checked+disabled pattern), Checkbox
  (hidden native input, indeterminate mixed state) — keyboard and
  screen-reader correct.
- 978d1d4: Master-key lifecycle: the master key is generated on first run and persists
  only OS-keychain-wrapped; versioned library keys (KEY #N) wrap under it,
  rotate forward while retired keys keep decrypting, and an unavailable
  keychain is a hard error — never a plaintext fallback.
- c5a2324: Library IPC service: the renderer's typed window into the library — paged
  queries with source, chip, and search filters (mock-exact substring
  semantics), photo lookup, favorite toggle that bumps pendingCount, sidebar
  counts, and StatusBar stats, plus targeted library.changed /
  pendingCount.changed push events. The library lazily boots on first use:
  keychain-backed keys, SQLCipher database, and blob store under userData.
- 1408b6b: List view: the dense 52px-row alternative, virtualized through the same
  engine in a single-column row mode — 40px protocol thumb, name, place · date,
  camera, size (mono), favorite star, and sync-status glyph, with the identical
  selection contract (circle toggles, row opens). The toolbar's Grid/List
  segmented switches views; the zoom slider hides in list view; toggling
  preserves selection exactly and scroll position approximately via the
  engine's anchor restoration.
- f2ab3ca: Overlay primitives: Dialog (scrim, focus trap, Esc/backdrop close,
  aria-modal) and Toast (four tones, aria-live, bottom-right host with 4s
  auto-dismiss) — the base every import/export/settings flow dialog builds on.
- 8514ac8: PhotoTile: the grid's cell with the full state matrix — selection ring with
  0.92 image scale, hover overlay and select circle, favorite star, sync
  status capsule, offloaded dimming — and independent open/select click
  targets.
- 71a10ec: Selection model completed per the mock: selection now survives filter and
  source changes for still-visible photos (intersected with each freshly
  loaded page instead of clearing eagerly), and a floating bottom-center pill
  shows "{n} SELECTED" with thousands separators plus the bulk-action entry
  points — Export, Add to album, Delete (disabled until their epics land) and
  clear-×. ⌘/Ctrl+A keeps selecting the visible set; Esc clears (lightbox owns
  Esc when open).
- d69e868: Sidebar: the 216px navigation rail per the mock — Library sources with live
  counts and cyan active-icon highlight, an Albums section listing the
  library's albums with membership counts over a new `library:albums` channel
  (display-only until M10), and the backup status card: encrypted badge,
  settings entry (M09 stub), an inert backup-progress slot while photos are
  pending, and the mono storage line from library stats. Counts, stats, and
  albums refresh on targeted library-changed pushes, so favorite toggles
  live-update the rail.
- 8d13729: Encrypted library database: SQLCipher-keyed SQLite (whole-DB at rest per
  ADR-0004), forward-only transactional migrations with schema v1, and a typed
  photos repository — keyset pagination, atomic insert with sync-ledger row,
  favorite toggle that dirties the ledger, and sidebar source counts.
- 37e987f: StatusBar: the 26px mono strip per the mock — "N PHOTOS · size" with
  thousands separators on the left; the right side flips between the amber
  spinning "ENCRYPTING n → PCLOUD" while photos are pending and the green
  "ALL BACKED UP · <relative>" otherwise (driven by ledger events; the engine
  itself is M08), plus the permanent AES-256 lock. A shared relative-time
  formatter (JUST NOW / 5M AGO / 2H AGO / 3D AGO) ships unit-tested for M08's
  real backup stamps.
- 644ac04: Thumbnail delivery: the `overlook-thumb://` protocol streams decrypts from
  the encrypted blob store straight into `<img>` tags — memory-only, no
  plaintext files. Main keeps a byte-capped LRU of decrypted thumbs over a
  small decrypt semaphore with in-flight dedup and cancellation for
  scrolled-past requests; content-addressed responses ship immutable cache
  headers so the renderer's HTTP cache short-circuits repeats. Missing thumbs
  404 (renderer placeholder until M05 backfills). The dev/E2E seed now writes
  real encrypted thumbs and its sample JPEGs actually decode.
- 9c35a56: Thumbnail generation worker (#86): a bounded `worker_threads` pool runs sharp
  off the main thread producing the ADR-0006 derivatives (512px WebP q80 thumb,
  2048px WebP q85 mid — sRGB, metadata stripped), RAF originals resolve their
  embedded preview first, undecodable bytes record a placeholder instead of
  failing the import, and derivatives stream encrypted into the blob store
  (encrypt-then-move, no plaintext temp files). A crashed worker rejects only
  its own job and the pool respawns without leaking capacity.
- 38f2479: TitleBar chrome: the 30px frameless-window bar is now a real component — mac
  reserves the native traffic-light inset, Windows/Linux get custom
  minimize/maximize/close controls (close hovers red) driving the typed window
  IPC; the whole bar drags the window.
- 854c109: Toolbar form controls: SearchField (shortcut hint, cyan focus, clear
  affordance), Chip (filter pill with selected state and removable ×), and
  Segmented (exclusive options, icon-only with tooltip, arrow-key operable).
- b914cc3: Toolbar: the full 48px command strip per the mock — cyan-aperture wordmark,
  debounced search wired to live library queries, funnel-toggled filter chips
  (Favorites / RAW / Offloaded / Local only, plus the SEMANTIC SEARCH hint),
  Grid/List segmented, zoom slider (visibility-hidden in list view), a backup
  button driven by pending-count state (disabled when everything is backed up),
  and the primary Import entry point. Backup/Import surface stub toasts until
  M08/M05 land; library stats now include the pending count so the backup state
  is honest from first paint.
- 769d5af: Typed IPC contract layer: all renderer↔main traffic rides a zod-validated
  channel/event registry (`src/shared/ipc`); the renderer sees only the typed
  `window.overlook` surface, malformed traffic rejects at the boundary, and a
  main→renderer event pattern (window focus demo) is in place for progress and
  settings pushes.
- 6fb9659: Virtualized grid engine for the 200K target: exact row/column math as a pure
  shared module (auto-fill columns, stretched square tiles, 4px gaps), windowed
  rendering with overscan, cursor-page data windowing with stale-request
  cancellation, zoom-anchor scroll restoration, and frame-drop instrumentation
  for the M11 perf budgets. The shell's content region now scrolls the real
  library; `npm run seed:perf` boots a 200,000-row synthetic profile for
  baselines.
