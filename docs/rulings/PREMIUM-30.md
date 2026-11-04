# PREMIUM-30

> Section: 2026-11-03 - Storefront premium defaults (PREMIUM-\*)

Ruling PREMIUM-30 - the built-in lockup never truncates its Latin line: the box keeps the full word (tracking is balanced by a start padding, not a negative end margin), the word keeps its own tracking through `lang=en` under the Arabic reset, an inline lockup stacks below md, and when the slot still cannot hold it the line collapses instead of ending in an ellipsis; the display name gets 0.3em of clip room so Lalezar marks are not cut (measured 390: QAMAR 58<63, JASMINE 47<53 before; fits after). Cost if wrong: a store with a very long Latin name loses the Latin line on a phone instead of showing a clipped one.
