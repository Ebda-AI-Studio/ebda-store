# SERVICES-COPY-APPROVED-1

> Section: Launch-eve content consistency pass (2026-11-10, branch `fix/marketing-content-consistency`), from the ebda.app content audit (findings C1-C28)

Ruling SERVICES-COPY-APPROVED-1 - the wording of the Marketing, Design and Events service pages (`/services`, `/services/{marketing,design,events}`) is APPROVED by Ahmad (2026-11-10, audit C14). The pages stay live: production builds with the repo variable `EBDA_SERVICE_LINES=on` (measured: `gh variable get EBDA_SERVICE_LINES` = on). Only the code comments that said the copy was a draft hidden until approval (brand `services` + `serviceLines`, `service-lines.ts`, `service-lines-content.ts`, `services-page.ts`) are updated; the flag and its off/preview/on behaviour are unchanged. Cost if wrong: none for visitors (the pages were already live); a reader of the old comments would wrongly think the live copy was unapproved.
