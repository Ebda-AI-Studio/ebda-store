# CLASSIC-SAVE-DRAFT-1

> Section: BOSTA-LIVE-READONLY (2026-10-08)

Ruling CLASSIC-SAVE-DRAFT-1 — the classic builder's Save (`PUT /layout`) keeps publishing what it edits, and MERGES that edit into any pending visual draft instead of leaving it stale or discarding it. Evidence: `publishLegacyLayout` never deleted the draft row, but left it behind the new head (409 on its next publish; a later Publish silently reverted the classic edit) and copied document-only sections from the draft into the live revision. Fix: `rebaseDraftOntoLive` applies only the fields the classic save changed, in the same savepoint as the new revision; document-only sections come from the live document only. Cost if wrong: a merchant who edited the SAME field in both editors gets the classic value (classic wins on the field it just saved), recoverable from the revision history.
