# ADMIN-CLOSE-UX-3

> Section: Admin audit closure 2026-11-09, UX track (branch `fix/admin-audit-closure`)

Ruling ADMIN-CLOSE-UX-3 - UX:ST-2: the stock-count close and reconcile confirmations show units, not money. The count-session payload (`CountLine` in `stock/scan/page.tsx`) carries `systemQty`, `countedQty` and `variance` only; no per-line cost exists on the page or in `/inventory/count-sessions/:id`, and adding it needs an API change outside the admin closure scope. Deriving a money value from another endpoint would show a guess. The dialogs keep line count (close) and differing-line count plus net units (reconcile); `page.count-confirm.test.tsx` covers both. Cost if wrong: the merchant approves a count without seeing its money impact.
