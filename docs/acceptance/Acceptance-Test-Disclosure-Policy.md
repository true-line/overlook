# Acceptance test — Disclosure classes (#509)

**Disclosure** (Settings ▸ Privacy) lists every classifiable metadata field
with its class. The rules are
[ADR-0032 §6](../adr/ADR-0032-Sharing-And-End-To-End-Encrypted-Collaboration.md):
**Private** never crosses a disclosure boundary, **Shared** may cross to a
named, authorized recipient (a folder you choose, Apple Photos, a keyed LLM
provider, a paired peer), **Public** may cross to an unauthenticated
destination. Local use is not disclosure — a private field stays indexed,
searchable and actionable on this device. Nothing defaults to Public;
precise location, ratings and face data default to Private; the rest
(title, description, tags, capture time, camera, lens, provenance evidence,
comments) default to Shared. The **Always private** list — key material and
references, recovery state, blob addresses and content hashes,
protected-album existence, app-lock state, provider credentials, custody and
coverage state, biometric-derived data, diagnostics identifiers, participant
device secrets — cannot be reclassified by any preference at any scope.

Scope resolves library → collection → photo → operation: any level may
narrow; widening takes an explicit action at that level and is never
inherited downward. The policy is one shared module
(`src/shared/disclosure/policy.ts`); main compiles the **disclosure plan**
for every crossing from the renderer's intent and builds the payload from
the plan, so a stale renderer or a direct channel invocation cannot widen
disclosure. Fields that travel inside the original bytes (capture time,
camera, lens, location) cannot be filtered per field: an Original export or
a Send to Apple Photos that would carry a withheld embedded field is refused
until the field is included for that one operation (recorded in Activity by
field name) or the export is Baked. Backup is not a disclosure boundary.
Policy changes and per-operation widening reach Activity by field name and
class only — never a value.

Automated coverage: `tests/e2e/disclosure.spec.ts`,
`tests/disclosure/policy.test.ts` (defaults, scope resolution, the plan,
boundaries that carry nothing), `tests/db/disclosure.test.ts` (migration
37, the repository's fail-safe parsing, the service's activity records),
`tests/export/export-engine.test.ts › disclosure classes`,
`tests/photo-kit/photo-kit-service.test.ts › withholds a private embedded
field`, `tests/file-provider/file-provider-service.test.ts › mounts the
capture time`, `DisclosureSettings.stories.tsx › Defaults / Preview`.

## Steps

1. Launch with `OVERLOOK_SEED=4`. Open Settings ▸ Privacy. **Expected:** a
   **Disclosure** section listing Title, Description, Tags, Capture time,
   Camera, Lens, Provenance evidence, Precise location, Ratings, Face data
   and Comments, each with a Private / Shared / Public selector; Precise
   location, Ratings and Face data read **Private**, every other field
   **Shared**, none **Public**. The section ends with an **Always private** list that has
   no controls.
2. Set **Capture time** to **Private**. **Expected:** the row updates
   immediately; Activity shows "Changed a disclosure class" with the field
   name and the classes, and nothing else.
3. Relaunch and reopen Settings ▸ Privacy. **Expected:** Capture time is
   still Private.
4. Select one photo → **Export**. **Expected:** the dialog shows **What
   leaves** section before the destination controls: a **Destination**
   choice set to **Named recipient** (its hint says Shared and Public fields
   cross), one row per field present in the selection with a neutral class
   badge (lock for Private, people for Shared, globe for Public), how many
   photos it crosses for and a sample value, and a note that capture time is
   embedded in the original bytes. Because capture time is private and the
   payload is Original, a notice says the originals cannot leave, a screen
   reader hears "The originals can’t leave while Capture time is withheld."
   (politely, not as an alert), and **Export 1 photo** is unavailable with
   "Include the withheld field, or export Baked." under the footer.
5. Tick **Include Capture time in this export**. **Expected:** the warning
   clears, the row reads "1 photo of 1", the button enables. Export.
   **Expected:** the file lands; Activity's export record names
   `disclosureWidened: captureTime` and no value.
6. Reopen Export, switch the payload to **Baked**. **Expected:** no warning
   even without the checkbox — a baked payload carries no embedded metadata.
7. Choose **Public** as the destination. **Expected:** its hint says only
   Public fields cross, and every row
   reads **Withheld** (nothing defaults to Public); with a Baked payload the
   export still runs and the file carries no title, tags or EXIF.
8. On macOS with Photos authorized, set Precise location to Private (the
   default), import a photo that has GPS, select it → **Send to Apple
   Photos**. **Expected:** the item fails with "Withheld by disclosure
   policy: location"; tick **Include Precise location** and it transfers.
9. Enable the read-only File Provider on an album. **Expected:** in Finder
   each file's date is the capture time while Capture time is Shared, and
   the import date after it is set to Private.
10. Ask the assistant (Settings ▸ AI) about a photo. **Expected:** the
    request carries the image and the question only — no title, location,
    camera or capture time in the request body, regardless of class.
11. Open a library created before this release. **Expected:** migration 37
    adds the policy at the §6 defaults; nothing that was shared before is
    widened, and location that was already never exported stays private.
