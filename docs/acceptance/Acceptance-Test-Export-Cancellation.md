# Export cancellation acceptance (#1217)

Governing contracts: [ADR-0031 §6](../adr/ADR-0031-Editing-Variants-Provenance-And-Export-Boundary.md#6-export-crosses-the-plaintext-boundary-in-one-declared-mode)
and the existing original-custody ownership rules. Applies to the filesystem
photo export engine used by selected, library-wide and protected exports.

## Result and ownership

Cancellation acknowledges the request without waiting for an unsupported IO
operation. The active unfinished photo entry and remaining entries contribute
to `cancelled`, not `failed`; genuine per-file failures remain in `failures`.
Progress advances only for finished entries. Once returned, the result and
progress cannot be changed by a late operation.

An entry commits after its original/Baked payload and every requested companion
finish. Earlier committed entries remain intact. An unfinished entry's outputs
are provisional and are removed together, including a completed original whose
requested companion was interrupted. Stored originals and source sidecars are
never changed. Collision cleanup removes only a file this writer created, so
an `EEXIST` winner remains intact.

Each acquired original reference has one owner and one release. A late custody
result is destroyed/released without opening a destination. Shared provider
acquisition retains other viewers' and exports' references.

## Bounds and unavoidable work

The acknowledgement bound is an abort-listener/promise turn on a responsive
event loop, independent of the pending operation's settlement. Controlled tests
use a one-second guard to detect a blocked caller; that guard is not a promise
that a stalled OS or blocked event loop meets a one-second wall-time budget.

Node stream pipelines receive the signal and destroy the stream chain. An OS
open/write already submitted can still finish. Cleanup waits for the descriptor
to close before unlinking, observes late failure, and cannot recreate the output
after retirement. Cleanup failures go to the existing diagnostic sink (redacted
for protected exports); acknowledgement does not claim cleanup succeeded.

Native Sharp processing cannot be synchronously interrupted. Each export
pipeline receives a **30-second processing timeout**, with cancellation checks
before subsequent stages. Sharp's pinned API documentation (`Sharp.timeout` in
`node_modules/sharp/lib/index.d.ts`) says its clock begins when libvips opens an
input; libuv queue wait is excluded. This is not a hard wall-time or process-kill
guarantee. At most one current native pipeline survives cancellation per runtime.

Provider `getStream` acquisition has no signal parameter in the current provider
contract and can be shared. It remains observed until it settles; an abandoned
export releases only its own reference afterward. There is no universal physical
completion deadline for provider or kernel work. The serialized runtime starts
no later batch until that work and its cleanup retire. `drain()` tracks physical
retirement, including late cleanup, rather than treating acknowledgement as a
stopped operation. Existing library-shutdown deadlines remain independent.

## Automated evidence

`tests/export/export-cancellation.test.ts` uses controlled promises and real
temporary destination files:

- Stall an original stream and a buffering seam; cancellation settles while
  subsequent reads/transforms stay unstarted.
- Stall custody acquisition and a native transform, then deliver late success
  or failure. Results stay unchanged, pending custody releases once and no late
  destination appears.
- Hold actual filesystem open/write callbacks across cancellation. Late success
  and failure close the descriptor before cleanup, with no output recreation.
- Interrupt a companion group, preserve a previous completed entry, and retain
  a pre-existing collision winner.
- Cancel a retained-sidecar preflight read without turning cancellation into a
  disclosure failure. Queue another export and close the runtime while the
  first operation is still retiring.

`tests/export/transcode-cancellation.test.ts` checks the configured timeout on
every native pipeline and stops an edited export after the active callback.
`tests/backup/ephemeral-originals.test.ts` proves a cancelled export cannot evict
shared custody. `tests/library/protected-library-service.test.ts` covers active
protected-read cancellation alongside authority revocation and redaction.

## Product check

1. Export several large photos, including an offloaded original, to an empty
   folder. Cancel while a later photo is reading or rendering.
2. Confirm the done summary distinguishes cancellation from file errors and
   retains earlier completed entries. After retirement, the active unfinished
   entry has no original or companion left in the destination.
3. Start another export while the first has unsupported work in flight. Confirm
   it waits for retirement, and closing/locking prevents queued work from
   starting. A provider/native callback completing later must not add files or
   change the cancelled result. Use controlled automated seams above for the
   deterministic stalled-operation evidence.
