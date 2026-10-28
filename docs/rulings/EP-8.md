# EP-8

> Section: Lifecycle emails and referral attribution (2026-10-22, branch `feat/lifecycle-emails`)

Ruling EP-8 (Task 10, 2026-10-22) - `rtlPolish` is removed from the Theme tab and from new-store seeding: no renderer reads it (the elegant empty-state arrow mirrors on every store since the a11y re-audit P2-N6), so the control did nothing on any skin. `personaChromeV2` is shown only to the skins that read it (bold, classic, elegant). The Theme tab is at 6 toggle cards of 7 (`themetab-ceiling.test.ts`). Cost if wrong: none for stored data (the key stays accepted); a skin that starts reading `personaChromeV2` must be added to `PERSONA_CHROME_SKINS`.
