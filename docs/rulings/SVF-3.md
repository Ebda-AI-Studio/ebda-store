# SVF-3

> Section: 2026-09-30 — single-variant products (branch `fix/single-variant-products`)

**Ruling SVF-3 — the PDP pre-selects a single variant only when its pill is tappable, and the
pre-selection never swaps the gallery.** Owner instruction 2026-09-30: nothing may look different
except the selected pill and the enabled button. Rule = exactly one variant listed, every picker
axis has a value, and the same availability test the pill uses for `disabled` (untracked or
inventory > 0) — so the pre-selected state is byte-for-byte what a tap produces. 14 live
single-variant products have a variant image that is NOT in the product gallery; a tap swaps the
main image to it, so the swap is tied to `onShopperSelect` (a real tap), not to the pre-selection.
Proved by before/after screenshots (en/ar × desktop/mobile, two products): page heights identical,
the only pixels that change are the option row and the button. Cost if wrong: a sold-out single
variant still shows "Select Options"/disabled, exactly as today.
