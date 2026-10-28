# EP-5

> Section: Lifecycle emails and referral attribution (2026-10-22, branch `feat/lifecycle-emails`)

Ruling EP-5 (Task 10, 2026-10-22) - a control no skin reads is removed, not hidden behind a flag, and its key stays in the save schema and in stored documents (`SectionDefinition.retired`, ignored by the reader, never migrated). Removed: Width on new-arrivals, best-sellers, product-carousel, testimonials and hero; the hero's Top / Bottom spacing (the hero wrapper never applied them). Cost if wrong: a stale key sits in a document's JSON.
