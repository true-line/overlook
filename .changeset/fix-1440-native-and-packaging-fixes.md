---
'overlook': patch
---

Fix `windows-interop` hoisted `node-gyp` lookup, clean up staged File Provider and PhotoKit temporary files on error/cancellation, harden `native_drag.mm` filename validation, exclude `binding.gyp`/`test*.cjs` from packaged builds, and sync `package.json` `allowScripts` with `package-lock.json` (#1440).
