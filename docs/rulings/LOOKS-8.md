# LOOKS-8

> Section: 2026-10-14 — Security batch (branch `fix/security-batch-2026-10-14`, audit: `docs/security/audit-2026-10-14.md`)

Ruling LOOKS-8 — `applyLook` auto-publishes the new family ONLY for a genuinely fresh store (`layout_settings` null, empty or equal to `NEW_STORE_LAYOUT_SETTINGS`, and no draft revision); every other store gets the family as a draft. This supersedes the plan's "publish when there is no published revision". Evidence: LOOKS-3 ("switching keeps content always") outranks it; publishing a merchant's unfinished draft would push in-progress edits live. Cost if wrong: an established store, or a new merchant with an abandoned draft, presses publish once.
