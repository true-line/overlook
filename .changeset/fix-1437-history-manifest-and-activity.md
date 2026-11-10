---
'overlook': patch
---

Mark backup manifest debt across all committed Undo/Redo/compensation history mutations, enforce activity retention on history events, and recursively reject nested sensitive fields and paths in activity payloads (#1437).
