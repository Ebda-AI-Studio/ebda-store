# LOOKS-9

> Section: 2026-10-14 — Security batch (branch `fix/security-batch-2026-10-14`, audit: `docs/security/audit-2026-10-14.md`)

Ruling LOOKS-9 — for a fresh store, sections that fail `validatePublishReadiness` (placeholder copy, a hero slide with no image) are dropped and the rest is published; if NO section survives the drop, nothing is published (the whole family is saved as a draft with a logged warning, never an empty live home); if the publish is still refused the store stays a draft with a logged warning, and `applyLook` does not fail. Evidence: a new merchant must land on a styled, live home, publishing placeholder copy is rightly refused, and a look switch must not fail on a builder edge (`applyFamilyForLook`, `dropUnpublishableSections`). Cost if wrong: a family's signature section is missing until the merchant adds it, or a fresh store keeps its starter home until they publish.
