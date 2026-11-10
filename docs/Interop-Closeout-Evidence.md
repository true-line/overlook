# Interop Closeout Evidence

Issues: [Overlook #337](https://github.com/true-line/overlook/issues/337) and
[Image Trail #590](https://github.com/true-line/image-trail/issues/590)

This is the release-evidence runbook for the bidirectional Image Trail and
Overlook interoperability epics. Do not close either issue from implementation
or mocked-provider evidence alone.

## Executable evidence map

Overlook owns the canonical
`design/handoff/contracts/v1/acceptance-evidence.json`. The contract checksum
includes that file, and Image Trail vendors the exact canonical bytes.

- `npm run check:interop-acceptance` verifies all ten epic scenarios, both
  repositories' stable automated references, and the shape of every manual
  entry. This command is part of normal CI.
- `npm run check:interop-closeout` additionally requires every manual entry to
  be `verified` with a timestamp and a GitHub evidence URL. It must fail while
  any owner-run check is pending.

After a test or file is renamed, update the canonical evidence reference and
checksum in Overlook, then vendor that exact contract commit in Image Trail. Do
not weaken the checker or replace a removed assertion with a path-only claim.

## Evidence record

Post one redacted result comment to both issues for each manual check. Include:

- check id and UTC timestamp;
- released tag/version and commit for both products;
- OS and architecture;
- provider and region/account class, but no account identifier, credential,
  token, key, password, local path, or original filename;
- reviewed totals for eligible, duplicate, conflict, metadata-only,
  unsupported, skipped, failed, acknowledged, and finalized;
- ciphertext/manifest checksum comparison and namespace observed;
- injected failure and recovery result;
- confirmation that source removal happened only after verified target
  acknowledgement and that reviewed Sync deletion did not apply silently;
- final reset/disconnect result.

When both comments exist, set the matching manifest entry to `verified` with
the comment URL and UTC `runAt`. Regenerate `SHA256SUMS`, vendor the exact
canonical update into Image Trail, and run `check:interop-closeout` in both
repositories.

## Prerequisites

1. Install released, signed builds of Overlook and Image Trail. Use disposable
   test profiles and dedicated provider folders/accounts.
2. Create a fresh password-protected pairing bundle. Keep the password and
   plaintext interop key out of issue comments, logs, provider storage, and
   persistent temporary files.
3. Seed at least two available originals, one metadata-only record, one album,
   one duplicate identity/content hash, one conflicting field revision, and one
   unsupported namespaced field in each product.
4. Record source checksums and counts before starting. Preserve an independent
   copy of every sole original.

## released-products-bidirectional

1. In Overlook, review and Move one available original plus the seeded album to
   Image Trail. Interrupt before acknowledgement and restart both products.
2. Confirm the source remains, resume, and verify the Image Trail record,
   original checksum, album order, provenance, and exact counts.
3. Confirm source finalization occurs only after the target acknowledgement
   reports durable metadata and verified original custody.
4. Move one available captured bookmark and one metadata-only bookmark from
   Image Trail to Overlook. Verify the metadata-only row never claims an
   original and does not trigger original deletion.
5. Start a reviewed two-way Sync. Exercise duplicate suppression, all three
   conflict choices, Apply to all, incremental change, pause/resume, and an
   interruption after acknowledgement.
6. Send a tombstone. Confirm it remains in delete review until an explicit
   decision. Disconnect and confirm both local libraries remain unchanged.
7. Confirm selection, active view/album, Queue order, progress counts, and
   backup pending state remain stable throughout.

## live-pcloud

1. Connect the dedicated pCloud account and select the isolated interop root.
2. Run a multi-chunk Move and Sync in both directions. Verify resumed chunks,
   downloaded ciphertext SHA-256, pagination, and exact acknowledgement counts.
3. Confirm interop objects exist only below the product's interop namespace and
   neither backup root can be listed or overwritten through the interop adapter.
4. Exercise offline, expired authorization, quota, missing object, corrupt
   chunk, and partial upload. Confirm typed recovery and intact sources.
5. Resume successfully, then disconnect without deleting either library.

## live-google-drive

1. Connect through the released least-privilege `drive.file` OAuth flow.
2. Run a multi-chunk Move and Sync in both directions. Verify the app-owned
   interop root, resumable offset, pagination, checksum/download-hash fallback,
   and exact acknowledgement counts.
3. Confirm the interop adapter cannot enumerate the normal Overlook or Image
   Trail backup roots.
4. Exercise stale access token, revoked refresh token, offline, quota,
   unavailable provider, corrupt download, and partial upload. Confirm the
   source remains until a fresh verified acknowledgement.
5. Reconnect and resume, then disconnect without deleting either library.

## signed-icloud-native-host

1. Install the signed/notarized Overlook build with its provisioned iCloud
   entitlement and native messaging host. Confirm the released Image Trail
   extension id is the only allowed origin.
2. With iCloud available, run bidirectional multi-chunk Move and Sync. Verify
   opaque bounded control frames, encrypted file references, materialization,
   checksum, and acknowledgement counts.
3. Exercise a placeholder/delayed materialization, account change, unavailable
   account, quota, conflict, missing host, wrong extension id, unsigned or
   unentitled host, malformed response, and oversized/byte-bearing frame.
4. Confirm every unsupported or invalid boundary fails closed without provider
   plaintext, source deletion, or access to either native database.
5. Restore the signed host/account, resume, then disconnect without deleting
   either library.

## Recovery and security review

- Wrong password/key, corrupted pairing data, replayed or changed messages,
  future schema versions, traversal paths, and mismatched transfer/pairing ids
  must fail before persistence or acknowledgement.
- Provider objects and logs may contain ciphertext, opaque ids, byte counts,
  timestamps, and ciphertext hashes only. Search the provider roots and
  diagnostic logs for seeded titles, URLs, filenames, metadata, credentials,
  passwords, and key encodings; none may appear.
- A failure before acknowledgement retains source metadata and originals. A
  failure after acknowledgement resumes the idempotent finalizer from its
  journal and must not duplicate deletion.
- If target verification is uncertain, stop. Keep both sources, disconnect the
  pairing, preserve the encrypted journals, and record the redacted failure on
  both issues before retrying.

## Final closeout

1. All repository CI, E2E, Storybook, provider contracts, privacy/security, and
   hardened package/release checks pass on the exact release commits.
2. All four manual entries contain current evidence from released products.
3. `npm run check:interop-closeout` passes in Overlook and Image Trail against
   the same canonical checksum.
4. Only then close #337, #590, #283, and #560.
