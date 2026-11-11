---
'overlook': patch
---

Preserve preexisting `EEXIST` blobs in `BlobStore.restoreOriginal`/`restoreSidecar` and shared-hash sibling variants in `RestoreEngine` when verification fails (#1431).
