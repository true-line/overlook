# Native Drag-Out Safety Acceptance Test

Issues: [#796](https://github.com/true-line/overlook/issues/796), [#1027](https://github.com/true-line/overlook/issues/1027),
[#1028](https://github.com/true-line/overlook/issues/1028), [#1137](https://github.com/true-line/overlook/issues/1137)

Native drag-out is disabled in production after the signed AppKit session
introduced by #796 was found to crash at drag initiation. The materializer and
native source remain for a separately reviewed redesign; they are not a shipped
capability while the production bridge reports `disabled`.

The disclosure posture is **refuse originals carrying withheld embedded
fields**, using main's shared export planner for a shared destination. The
materializer is original-only and carries the same embedded fields as
Original-only export (capture time, camera, lens, location); it copies no source
sidecars or authored metadata and adds no new boundary. It has no operation
widening or native Baked mode. Use ordinary **Export → Baked** instead; that
separate export path is covered by the disclosure/export tests.

## Automated contract

- Begin a drag on one selected ordinary photo and on a multi-selection. Confirm plaintext is not opened until a receiver accepts an individual file promise.
- Confirm duplicate names receive deterministic numbered suffixes and the private Overlook selection payload remains present for internal album drops.
- Confirm missing, deleted, protected/migrating, locked, malformed, and oversized selections produce no promise.
- Confirm offloaded originals use verified ephemeral custody, release it after the promise settles, and never become durable as a side effect.
- Cancel or lock during materialization. Confirm the stream aborts, partial output is removed, native promises fail, and library shutdown waits for release.
- Import the EXIF GPS fixture with location Private. The materialization harness
  must refuse the whole native selection before advertising a promise or
  opening an original. The refusal names `location`; the renderer notice names
  Precise location and suggests Export → Baked. Internal album-drag data remains
  present. Repeat with withheld capture time, camera and lens.
- With all carried fields permitted, accept a promise and confirm byte-exact
  output and lazy custody release. Activity records `photo.exported` with field
  names and approved Shared/Public classifications only: no GPS values, camera
  strings, filenames, paths, content hashes, or custody details.
- Narrow library or photo policy after advertisement, while opening offloaded
  custody, and during streaming. Confirm current policy is recomputed in main,
  withheld bytes are refused, partial output is removed, custody is released,
  and no successful crossing is recorded. Repeat after lock, protected
  migration, deletion or source replacement.
- Direct native-drag IPC cannot request a Baked mode or operation widening.

`tests/native-drag/*` proves the planner/materializer and disabled-bridge
contracts. `tests/e2e/native-drag-out.spec.ts` exercises real app import,
renderer refusal and materialization through **TestNativeDragBridge**. Neither
enters the signed AppKit session initiation path or satisfies #1028's evidence
gate. Automated materialization evidence does not close #1137's remaining
native-session acceptance.

## Signed packaged macOS safety check

1. In a signed/notarized build, click an ordinary photo and begin dragging it without leaving the Overlook window. Repeat rapidly in grid and list views. Confirm the app remains responsive and does not terminate.
2. Move ordinary photos between Overlook albums. Confirm the existing internal copy/move semantics remain intact and cancelled drags release their visual state.
3. Drag toward Finder, Safari/Chrome, Mail, and Preview. Confirm Overlook remains responsive and does not advertise or materialize a native file promise while the bridge is disabled.
4. Repeat with one selected photo, a multi-selection, an offloaded photo, and while locking Overlook. Confirm no plaintext scratch or receiver file appears.
5. Drag files from Finder into Overlook and drop a recovery key on its declared target. Confirm these independent inbound paths remain responsive.

## Dependency and future signed receiver evidence

#1028 is blocked on a signed minimal prototype proving one authoritative drag
session, repeated in-window initiation/cancellation and the actual event
lifecycle. That evidence must land before the session redesign is implemented.
Do not flip production `enabled: false` to exercise the materializer tests.

After #1028 supplies the accepted signed path, repeat the disclosure cases
above in a signed packaged build with Finder, browser and native-app receivers.
Verify the actual refusal notice, permitted field/value preview, receiver
behavior, internal album fallback, lock revocation and absence of retained
plaintext. Record build/signature, receiver and start/cancel results separately
from automated materialization evidence. Until that evidence exists, #1137's
signed native-session acceptance remains explicitly blocked by #1028.
