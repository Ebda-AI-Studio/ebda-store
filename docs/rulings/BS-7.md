# BS-7

> Section: 2026-10-01 — backlog batch b-services (branch `fix/backlog-b-services`)

**Ruling BS-7 — issue 2147 reverses M5-6: a stock-computing query no longer pre-filters variants to
`isActive`.** M5-6 accepted the fallback because the parent column "is held at 0 by the invariant",
but `VariantService.createOption` converts a stocked simple product to variants without zeroing it,
so the PDP and the WhatsApp bridge advertised the old parent stock for a product whose variants were
all disabled. They now select every variant with `isActive` and drop the disabled ones for display
after the stock is computed; a unit gate fails on the pre-filtered shape in any stock-computing file.
The conversion path itself is NOT changed to zero the parent column — that is a stock write whose
correct target (discard the units, or move them onto a variant) is a merchant decision. Cost if
wrong: none on reads; the stale parent value stays on the row, unread.
