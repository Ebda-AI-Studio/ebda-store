# AN-6

> Section: 2026-09-30 — Analytics batch 1 (branch `fix/analytics-batch-1`, PR #2220)

**Ruling AN-6 — insights repeat-purchase groups buyers with `customerKeyOf`; this branch's
`guestKey` (`GUEST:sha256("<email>:<phone>")`) import is removed.** Main deleted `guestKey` from
the RFM rollup in favour of `customerKeyOf` + `rfmKeyFor` (ruling AP-12). The repeat-purchase rate
now groups exactly as the Customers page and RFM do: user id, else lowercased (untrimmed) email,
else phone. Behaviour change: a guest who reuses an email with a new phone is ONE buyer (was two);
an email differing only by surrounding whitespace is now TWO (was one) — the Customers-page rule,
kept for URL stability. Cost if wrong: a store whose guests type emails with stray spaces sees a
slightly lower repeat rate than the old key gave.
