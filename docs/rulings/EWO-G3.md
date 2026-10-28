# EWO-G3

> Section: Cluster G — product cards, error fallback, UI

**Ruling EWO-G3 — #1996: lifted badge tiers are clamped to the image box; the compound short-box
case is an accepted residual.** `bottom-[min(6rem,calc(100%-2.25rem))]` (9rem when stacked; the
chip below a stacked one reserves 4.5rem) keeps every tall-box placement byte-identical and stops
a 16:9 / short square image from clipping the chip away. On a box shorter than the CTA band plus a
chip there is no pixel that is both inside the image and clear of the band, so the chip may sit
over the band there. Cost if wrong: on a 16:9 `sm` card on mobile the chip overlaps the Add-to-Cart
band instead of disappearing — visible, not lost.
