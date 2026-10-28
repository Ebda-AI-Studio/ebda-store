# EWO-F6

> Section: Cluster F — agent discovery, llms.txt, SEO, i18n

**Ruling EWO-F6 — #2193: in Arabic, a meaningful English axis name that the option-name map can
translate outranks value detection, mirroring the English branch.** `Size` + `185 Gram` now reads
"Size" / "الحجم" (was "Size" / "الوزن"). An English name the map cannot translate (e.g. "Pack
size") still falls to value detection in Arabic. Pinned as EN/AR pairs in
`tests/unit/option-localization.test.ts`. Cost if wrong: an OSOSS weight axis stored as "Size"
reads "الحجم" rather than "الوزن" on Arabic storefronts — the merchant's own word, translated, over
an inference.

**Note — #1958 closed as already fixed:** acp.json (`authentication.write: 'api_key'`
unconditionally) and ucp (`auth.write: 'api_key'` unconditionally) no longer branch on
`agent_checkout_open_writes`, and `tests/unit/well-known-agent-discovery.test.ts` asserts
non-disclosure with the hatch on — all three surfaces agree (fixed in #1942).
