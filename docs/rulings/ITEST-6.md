# ITEST-6

> Section: Lifecycle emails and referral attribution (2026-10-22, branch `feat/lifecycle-emails`)

Ruling ITEST-6 - builder.e2e "page settings: filters on the collection page" polls the mock-api draft (`expect.poll`, 15 s) instead of one read after `waitSaved`; the asserted value is unchanged. `save-status` reads "saved" from the page open until the debounced autosave of the edit marks it dirty, so a slower runner read the draft before it existed. Cost if wrong: none for the product; the other waitSaved-then-state reads in the file passed in the same run and keep the single read.

---

> Section: Lifecycle emails and referral attribution (2026-10-22, branch `feat/lifecycle-emails`)

Ruling ITEST-6 - builder.e2e "page settings: filters on the collection page" polls the mock-api draft (`expect.poll`, 15 s) instead of one read after `waitSaved`; the asserted value is unchanged. `save-status` reads "saved" from the page open until the debounced autosave of the edit marks it dirty, so a slower runner read the draft before it existed. Cost if wrong: none for the product; the other waitSaved-then-state reads in the file passed in the same run and keep the single read.
