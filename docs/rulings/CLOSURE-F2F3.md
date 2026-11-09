# CLOSURE-F2F3

> Section: Admin audit closure 2026-11-09, phase 2 (branch `fix/admin-audit-closure`)

Ruling CLOSURE-F2F3 - BE:F-2 and BE:F-3 (DO-store settings patch and branding-bundle atomicity) are not implemented in this pass. True atomicity needs a new StoreDO batch/patch op (a DO storage transaction over settings + branding + theme + contact), i.e. a DO protocol change in `packages/repo` plus workerd DO tests, not a small route-level change; FP-5 (read-merge-write window of milliseconds) and FP-8 (ordered idempotent parts, a repeat save converges) stay as written and the client already sends only the keys it owns. Next step when scheduled: add `store.patchSettings` and `store.applyBundle` ops to the DO and call them from `updateBrandingBundle`/settings PUT. Cost if wrong: two writers inside the same few milliseconds can still lose a settings key, and a failed bundle on a DO store leaves its earlier parts written until the merchant saves again.
