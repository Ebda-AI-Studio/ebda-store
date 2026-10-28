# LOOKS-11

> Section: 2026-10-14 — Security batch (branch `fix/security-batch-2026-10-14`, audit: `docs/security/audit-2026-10-14.md`)

Ruling LOOKS-11 — resetting a look override from the builder is draft-first: flush pending autosave, remove the key from the draft theme (omit it, never `null`) via `replaceDocument` + `saveDraftNow`, then `PUT /stores/:id/theme { key: null }` to live only if live holds it. Evidence: the Task 8 review found a live-only reset was undone on the next publish and a draft-only reset left live untouched, and an unflushed autosave could resurrect the key. `PUT /stores/:id/theme` treats `null` as delete (no admin surface wrote a null theme value, audited 2026-10-14). Cost if wrong: one extra request.
