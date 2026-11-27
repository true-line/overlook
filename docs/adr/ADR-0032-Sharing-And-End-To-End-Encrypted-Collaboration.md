# ADR-0032: Sharing and End-to-End Encrypted Collaboration

## Status

Accepted 2026-07-29 on
[#793](https://github.com/qwts/overlook/issues/793). This ADR governs
[#518](https://github.com/qwts/overlook/issues/518),
[#509](https://github.com/qwts/overlook/issues/509), and
[#517](https://github.com/qwts/overlook/issues/517), and records the
custody decisions that
[#519](https://github.com/qwts/overlook/issues/519) surfaced as blocking.
It extends
[ADR-0004](./ADR-0004-Encryption-And-Key-Management.md),
[ADR-0005](./ADR-0005-Library-Data-Model.md),
[ADR-0007](./ADR-0007-Backup-Format-And-Offload.md),
[ADR-0008](./ADR-0008-Recovery-Key-Format.md),
[ADR-0011](./ADR-0011-Provider-Catalog-Capabilities-And-Switching.md),
[ADR-0013](./ADR-0013-App-Lock-Key-Release-And-Protected-Albums.md),
[ADR-0015](./ADR-0015-Deterministic-Reviewed-Sync-Journals.md),
[ADR-0017](./ADR-0017-Multi-Library-Registry-Keying-And-Lifecycle.md),
[ADR-0018](./ADR-0018-Semantic-Search-And-Language-Model-Architecture.md),
[ADR-0021](./ADR-0021-Opt-In-Crash-Diagnostics-Privacy-Boundary.md),
[ADR-0023](./ADR-0023-Trash-Purge-And-Destructive-Action-Ceremony.md),
[ADR-0025](./ADR-0025-Encrypted-Activity-History-And-Capability-Aware-Undo.md),
and
[ADR-0031](./ADR-0031-Editing-Variants-Provenance-And-Export-Boundary.md). It
rewrites none of their custody, deletion, or recovery guarantees.

Section map: §1 governs participant and device identity; §2 governs #517's
keyring; §3 the shared namespace; §4 invitations and capabilities; §5 the
record log and conflicts; §6 governs #509's disclosure policy; §7 revocation,
leave, delete, and recovery; §8 the threat model that binds all of them.

Implementation may choose table, channel, and service names. No child issue may
change the identities, capability semantics, disclosure classes, enforcement
boundary, or revocation limits recorded here without an ADR amendment.

## Context

Overlook's entire security story assumes exactly one custody holder. The master
key is sealed to one OS keychain, every blob is sealed under one library key
lineage, the database is one SQLCipher file, and the only remote namespace is a
backup mirror of ciphertext nobody else is meant to read. Collaboration breaks
each of those assumptions at once:

- a second person needs a key, and ADR-0004's hierarchy has no tier below the
  library key to give them;
- a photo readable by a peer cannot keep its metadata in plaintext database
  columns, or the per-item key protects nothing that matters;
- the backup namespace and its credentials are a private mirror. Reusing either
  for shared objects would put another participant's writes inside the user's
  disaster-recovery custody;
- comments and concurrent edits arrive out of order from devices that were
  offline, so delivery order cannot decide meaning;
- "share this photo" is a disclosure decision about dozens of metadata fields,
  and today no layer below the renderer knows which fields may leave;
- revocation in an end-to-end encrypted system cannot retract plaintext a
  recipient already holds, and the product must say so rather than imply
  otherwise.

The cluster needs one contract before keyring, disclosure, or collaboration
work begins.

## Decision

### 1. Participants and devices are cryptographic identities, not accounts

A **participant identity** is a long-lived Ed25519 signing keypair plus an
X25519 agreement keypair. It is **profile-scoped**, sealed by `safeStorage`
under the per-profile directory beside `provider-auth/` and `llm-auth/`
(ADR-0018 §7) — outside every library directory and outside every backup
surface by construction.

A **device identity** is a per-installation Ed25519 subkey signed by the
participant identity. Records are signed by the device key; the roster trusts
the participant key. Losing one device revokes one subkey, not the identity.

A participant is displayed by a **fingerprint** — SHA-256 over the public
signing key, rendered in ADR-0008's grouped human-checkable format — plus a
user-chosen local nickname that is never transmitted. There is no account, no
directory, no discovery, and no server that knows a participant exists.
Verification is out of band; until a fingerprint is confirmed, the participant
shows as unverified in every surface that names it.

The participant secret is **not** recoverable from ADR-0004's recovery phrase,
because it does not live in the library. It is exportable through its own
explicit one-time ceremony using the ADR-0008 key-file format. A profile
restored without that export keeps read access to every space whose key the
keyring restored, but mints a **new** authorship identity that peers must
re-verify before accepting its writes. This is a designed consequence: identity
continuity is a thing the user must deliberately carry, not a thing the backup
provider silently holds.

### 2. Item keys are the third tier of the key hierarchy

ADR-0004's hierarchy becomes master key → versioned library keys → **item and
space keys**. The `keys` table gains `kind` (`library | item | space`), a
non-secret 128-bit `key_ref`, `version`, `fingerprint`, user `label`, `origin`
(`local | imported | received`), and `wrap_scheme`. Envelope headers already
carry a key id; they now carry `(key_ref, version)`.

Resolution is library-scoped: reading any encrypted object resolves its
`key_ref` through the keyring. A miss is not an error state to be papered
over — **`locked` is a first-class item state**. A locked item may show only
key-independent facts: that it exists, its ciphertext size, its key fingerprint
and label, and when it entered the library. Filename, EXIF, place, tags,
thumbnails, and search text are unavailable, because they are not stored in
readable form.

That last point is a schema consequence, stated so #517 cannot implement around
it: **an item sealed under a key other than the library key does not keep
plaintext metadata columns.** ADR-0005's per-photo columns remain the storage
for ordinary library-key items. A foreign-key item stores its metadata as a
sealed document under its own item key, with only key-independent columns in
the row. When the key resolves, a decrypted projection is materialized into a
cache table inside the same SQLCipher database so search, filters, and counts
keep working; the projection is dropped when the key is removed or app lock
releases it (ADR-0013). Otherwise a per-item key would protect the pixels and
publish the story.

Custody follows ADR-0004 exactly: imported and received keys are wrapped by the
master key, plaintext key material exists only in `KeyStore` memory, nothing
plaintext is ever written to the database or a log, and app lock zeroizes.

Keyring ceremonies:

- **Import** accepts a key file or pasted key, validates it against at least
  one addressable object, and records label, fingerprint, and usage count. A
  duplicate import is idempotent. A key matching nothing in this library is
  refused with that exact reason, not stored hopefully.
- **Rotation** mints a new version that becomes the write key for that key's
  domain. Existing objects stay on their sealing version — ADR-0004's rotation
  decision carried forward unchanged, and stated in-product.
- **Removal** is Tier M under ADR-0023 when other custody exists, and Tier D
  with the full ceremony and exact counts when it would strand the only
  decryptable custody for any item.
- **Backup manifests reference `(key_ref, version)` and never secrets.**
  Imported and received keys are keyring entries, so ADR-0004 recovery restores
  them with the master key; a manifest generation that names a key the restored
  keyring lacks yields locked items, never a failed restore.

### 3. Shared spaces are a separate namespace with separate credentials

A **space** is a ULID with its own space key lineage, signed roster, record
log, and blob namespace. Its remote layout is a distinct root:

```
/Overlook-Shared/<space-id>/
  roster/          # signed, generation-numbered roster documents
  records/         # encrypted, authenticated append-only records
  blobs/<h2>/<h>   # encrypted originals and derivatives, space-key sealed
  keys/            # space-key versions wrapped to each participant
```

This root is never `/Overlook/<library-id>/` and never the sibling product's
root (ADR-0007's writer-isolation stance applies unchanged). **Backup
credentials are never reused for a space.** A space holds its own provider
connection record, may live on a provider the library does not back up to, and
its provider is selected from ADR-0011's capability descriptors — a space host
needs `put`/`get`/`list`/`delete` but no checksum call, because record
integrity comes from signatures rather than provider attestation.

A space is not backup, in both directions. Sharing a photo never makes it
recoverable, never sets `synced`, and never satisfies ADR-0007 offload
eligibility. Conversely a photo's custody state — offloaded, local-only,
excluded from backup — is private and is never published into a space.

Sharing re-seals bytes. An ADR-0031 original asset entering a space is
re-encrypted under the space key into the space blob namespace, addressed by an
HMAC of the plaintext hash under the space key so equality is visible only
inside that space. ADR-0007's encrypt-once rule deliberately does not cross
this boundary: handing a peer the library envelope would mean handing over the
library key. One extra ciphertext copy per shared original is the accepted cost
of end-to-end encryption, recorded here rather than discovered later in a
storage-total bug report.

### 4. Capabilities are granted independently on a signed roster

An **invitation** is an out-of-band bundle carrying the space id, a provider
locator, the current space key version wrapped either to the invitee's X25519
public key or, when no public key is known yet, under an ADR-0008 KDF-derived
passphrase; plus the inviter's fingerprint, the offered capability set, an
expiry, and a single-use nonce. Nothing about an invitation transits a service
Overlook operates, because Overlook operates none.

Capabilities are `read`, `comment`, and `edit`, granted independently and
non-implied: `edit` does not confer `comment`. `admin` — the right to change
the roster — is held by the creator and may be granted explicitly.

The **roster** is a generation-numbered document listing participant keys,
capabilities, and grant provenance, signed by an `admin` participant. Each
generation commits to the hash of its predecessor, so the roster is a hash
chain: a fork is detectable rather than merged, and a forked roster is
surfaced for review instead of resolved by arrival order.

Enforcement is honest about where it lives:

- **Read is enforced by key possession.** Without a space key version, the
  bytes are opaque.
- **Write is enforced by signature validation at every reader.** The provider
  is dumb storage and enforces nothing.
- Readers bound record count and size per participant per generation and report
  a space that exceeds its limits, rather than downloading without limit.

**Position in the log is not evidence.** Because storage enforces no ordering,
a removed participant holding an old space key could otherwise mint a record
under the pre-removal generation, with a back-dated ULID and plausible causal
parents, and no reader could prove it was authored after the cut. Ordering
therefore has to be authenticated, not inferred:

- **Every record names the roster generation hash it was authored under**, bound
  in its AAD (§5).
- **A roster generation that reduces any capability carries a revocation
  anchor**: a Merkle root over the record ids the signing `admin` has accepted
  at the cut, plus, per participant, that participant's highest accepted
  sequence number.
- **A record is accepted only if** it is authored under the current generation
  and its author holds the capability there, **or** it is authored under a
  superseded generation _and proven to precede the cut_ — covered by the
  succeeding generation's anchor, by Merkle inclusion or by a sequence number
  at or below that author's anchored high-water mark.
- **Everything else is rejected**, whatever its ULID or claimed parents. A
  rejected record is surfaced with its reason, never silently dropped.

Two honest costs follow, and neither may be papered over in copy. A record
authored offline under generation _g_ and uploaded after the cut is rejected as
`superseded-roster`, because it is indistinguishable from a back-dated forgery;
an author who still holds the capability is offered re-authoring under the
current generation, and one who does not has genuinely lost the write. And an
anchor is only as good as what its signing `admin` had seen — a legitimate
record the admin never observed falls outside the anchor and is rejected on the
same terms.

### 5. Records are append-only, authenticated, and reviewed on conflict

Record types are `photo`, `variant` (an ADR-0031 revision document),
`metadata` (shared-class fields only, §6), `comment`, `roster`, and
`tombstone`.

Each record carries the space id, a record ULID, the author participant and
device, a per-participant sequence number, and its causal parents. The payload
is sealed with ADR-0004's chunked AES-256-GCM envelope under the space key,
with AAD binding space id, record id, record type, author, the author's
sequence number, and the **hash** of the roster generation it was authored
under; the sealed record is then signed by the author's device key. Replay,
cross-space substitution, author swapping, truncation, and re-labelling a
record onto a different roster generation all fail closed. Per-participant
sequence numbers are strictly increasing and gap-checked, so an author cannot
mint a record below their own anchored high-water mark to slip under §4's
revocation cut.

The log is append-only. An edit is a new record; a deletion is a tombstone.
Nothing is rewritten in place, so a peer that was offline for a month replays
rather than reconciles.

Offline writes queue in an encrypted local outbox with explicit durable states
— `queued | uploading | delivered | rejected | conflicted` — surfaced with the
same honesty as the backup ledger's failure vocabulary. A record is never shown
as delivered before the provider acknowledged it.

Conflict resolution is by type, never by arrival order. Comments are
commutative and cannot conflict. Roster generations are totally ordered by the
predecessor-hash chain in §4, and a fork in that chain is a reviewed conflict
rather than a merge. Shared metadata fields and variant
edit heads follow ADR-0015's deterministic reviewed-journal rules: concurrent
heads are surfaced for explicit review, with authorship and time shown, and
last-writer-wins is not available as a silent default.

### 6. Every field has a disclosure class, compiled below the renderer

Each metadata field carries exactly one class:

- **private** — never crosses a disclosure boundary;
- **shared** — may cross to named, authorized recipients;
- **public** — may cross to an unauthenticated destination.

Local use is not disclosure. Private fields remain fully indexed, searchable,
filterable, and actionable on device; classification governs export, interop,
space records, diagnostics, language-model requests, and external indexes only.

A **pinned-private set** cannot be reclassified by any preference at any scope:
key material and `key_ref` values, recovery state, blob addresses and plaintext
content hashes, protected-album existence, names, and counts (ADR-0013),
app-lock state, provider credentials and account identifiers, per-photo custody
and backup-coverage state, biometric-derived data, diagnostics identifiers
(ADR-0021), and participant device secrets.

Defaults for the classifiable set: title, description, tags, capture time,
camera, lens, and ADR-0031 provenance evidence default to **shared**; precise
location, ratings, and face data default to **private**; nothing defaults to
public. Comments are shared within their space and are not exportable to a
public destination by default.

Scope resolves library → collection → photo → operation. Narrowing is allowed
at any level; widening requires an explicit action at that level and is never
inherited downward as a silent default.

Enforcement is a single `src/shared` policy module that compiles a
**disclosure plan** — the exact field set, per recipient, for one boundary
crossing. The main process recomputes the plan and builds the payload from it;
the renderer supplies intent, never a field list. A stale renderer, a replayed
IPC call, or a direct channel invocation therefore cannot widen disclosure,
which is the same process-trust posture ADR-0023 §6 applies to destructive
authorization.

Before any disclosure the user sees an exact preview: which fields, which
values, which destination or recipient, and what changes if they decline.
Policy versions and consent changes are recorded in ADR-0025 activity history
**by field name and class only** — recording the value would defeat the point.

Backup is not a disclosure boundary. It is ciphertext under the user's own
keys, so no classification applies to it and no setting can reclassify backup
content as shared or public.

### 7. Revocation is forward-only, and the product says so

**Removing a participant** advances the roster generation with a signed removal,
publishes that generation's revocation anchor (§4), mints a new space key
version, and wraps it to the remaining participants. All subsequent records seal
under the new version, and the anchor is what stops the removed participant from
writing under the old one. Records already downloaded, and records still sealed
under an old version the removed participant holds, remain readable to them.

The ceremony copy is fixed by that fact: _"Removing them stops them from
reading anything shared from now on. It cannot delete or un-see anything they
already have."_ No surface may imply cryptographic retraction.

**Leaving** a space deletes the local space keys, records, outbox, and space
blob copies, and optionally publishes a departure tombstone. Records the
leaver authored remain in the log, because other participants hold them.

**Deleting a space** is Tier D under ADR-0023: it removes the remote objects
through the provider's recoverable deletion (the #750 amendment applies
unchanged), removes local copies, and discloses that other participants keep
whatever they downloaded. It never claims to erase a peer's device.

**Purge interaction.** ADR-0023 §4's derived-death list gains space membership
rows, outbox entries, space blob copies, cached foreign-key metadata
projections, and per-photo disclosure decisions. ADR-0023 §6's side-effect
enumeration gains one line whenever the purged photo was shared: copies held by
other participants are not deleted.

**Recovery.** Space and item keys restore with the keyring (§2). The
participant identity does not (§1). A restored library therefore reaches
`read` immediately and `comment`/`edit` only after peers re-verify the new
identity — stated in the restore flow, not discovered when a comment is
rejected.

### 8. Threat model

**Protects against:** the provider operator and anyone with provider
credentials; a network observer, beyond object sizes, counts, and timing; other
OS users without the keychain session; a removed participant's _future_ reads
and _future_ writes, including writes back-dated under a pre-removal roster
generation (§4's anchor); tampered, replayed, reordered, or forged records; a
stale or compromised renderer attempting to widen disclosure.

**Does not protect against:** a compromised participant device, or a
participant who chooses to leak; plaintext a recipient already downloaded;
traffic analysis of object count, size, and timing; a malicious inviter
presenting a fingerprint they do not control — out-of-band verification is the
only defense and the UI must say so; metadata the user classified as shared; a
compromised OS or session on any participant's machine; a compromised or
dishonest `admin`, whose anchor can omit records that were genuinely authored
before a cut — the fork-detectable roster chain makes that visible to other
participants rather than preventable.

**Deliberately not built:** public link sharing, discovery or a social graph,
server-side moderation or indexing, key escrow, and any "unsend" affordance.
Each is excluded because it would either require a service that can see
participants or a promise the cryptography cannot keep.

## Consequences

- ADR-0004's hierarchy grows a tier and every envelope read becomes a keyring
  resolution. `locked` becomes a state the whole renderer must handle, not an
  error path.
- Per-item keys force a second metadata storage shape. Ordinary library-key
  photos keep ADR-0005's columns; foreign-key items pay a sealed document plus
  a droppable projection, and search behavior becomes key-availability
  dependent.
- Sharing costs a second ciphertext copy per original. Storage totals, offload
  accounting, and purge disclosure all have to name space copies separately
  from backup copies.
- Authenticated revocation costs offline authorship. A record written offline
  and uploaded after a roster cut is rejected rather than accepted on trust,
  because the two are indistinguishable to a reader — so the outbox needs a
  re-author path and honest copy, and admins publishing a cut need to know
  their anchor defines what "already written" means.
- Disclosure moves from a renderer concern to a compiled plan in `src/shared`,
  which makes every existing boundary — export, interop, diagnostics,
  language-model requests — a consumer that must be retrofitted.
- The product gains a permanent honesty obligation: revocation is forward-only,
  invitations are only as trustworthy as the fingerprint check, and no copy may
  soften either.
- #517 implements §2; #509 implements §6; #518 implements §1 and §3–§5 and
  consumes §7–§8 for its recovery and threat documentation. #519's key-custody
  question is answered for sharing only — a native-platform port still needs
  its own ADR before reusing §1's custody shape.

- **Revisit when:** a participant count beyond small-group sharing makes
  wrap-per-participant key distribution impractical; or a credible
  provider-neutral transport removes the need for a shared blob namespace at
  all.

## Amendment — operation consent capability (#1141)

Accepted as part of #1141's implementation of §6. A renderer preview and its
`operation.widen` list express a proposal, never authorization. Passive previews
mint nothing. To authorize widening, main presents a native confirmation built
from its own policy and photo records: the selection, boundary, destination
class, exact field values and which cross, the widening fields, and the effect
of declining (no export; choose Baked or remove the widening). Cancel is the
default. Only affirmative confirmation may return an opaque capability through
`disclosure:preview`. Renderer assertions of confirmation are insufficient.

The capability is main-memory-only, short-lived and single-use, bound to the
photo IDs (including the resolved Export all selection), boundary, destination,
operation (widening and narrowing), payload/metadata mode, policy version and
policy/override revision, active library and authorization epoch. The confirmed
preview and exact per-photo values are also bound: main recomputes and compares
them after confirmation and at redemption, so metadata changes cannot substitute
unreviewed values. Main consumes the capability synchronously before
asynchronous export work. Export plans use the stored operation, never a
renderer-supplied widening list. Failed binding checks also burn the capability.
Policy or override changes, lock, library switch and use invalidate it. No
capability is needed when no operation widening is requested. Neither token nor
preview values enter Activity; widening is recorded only by field name.

## Amendment — retained source companions (#1142)

Source metadata is part of the export disclosure boundary. Before any output is
written, main inspects retained XMP for the supported export fields and applies
the same per-photo plan to its actual contents. A withheld field refuses the
batch; stored companions remain immutable. Metadata: Edits/None and payloads
that omit source companions require no inspection of those omitted bytes.

For XMP, previews and consent include the discovered fields and values, even
when they differ from the photo record. Malformed, oversized or unreadable XMP
is refused rather than treated as empty. Inspection must not resolve external
entities or access a network resource.

Unknown companion formats have no trustworthy field/value projection. Their
preview names the file and this uncertainty, and treats every withheld export
field as potentially present. They may cross only when the compiled plan
allows every export field; operation widening uses the main-owned ceremony to
explicitly authorize those named fields with unknown values. This exception
does not reclassify pinned-private data or authorize fields outside the export
boundary. A malformed known format does not qualify for this exception.

Consent binds immutable companion identities and the inspected findings.
Asynchronous inspection may follow synchronous, single-use capability
consumption; no export starts until validation succeeds. Main rechecks policy,
authorization and content identities across inspection, and verifies the exact
companion bytes it copies. No inspection rewrites the retained source.

Valid XMP is not necessarily fully classified XMP. A metadata property outside
the supported export projection (for example ratings, comments or face regions)
refuses Source export even when every supported export field is widened. RDF
and XMP structural wrappers are not metadata properties. Preview identifies
unclassified properties; Edits/None remains the way to omit that source packet.
