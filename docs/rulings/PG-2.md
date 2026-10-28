# PG-2

> Section: 2026-10-03 — scoped-audit follow-ups (branch `fix/backlog-followups11`, issues 2427, 2429-2432, 2434)

**Ruling PG-2 — the `{ data, meta }` list routes are read with `apiGetPage` everywhere (issue 2430,
closes the class opened by 2417).** `/finance/journal`, `/finance/bank-statements`,
`/finance/bank-statements/:sid/transactions` and `/purchase-orders` now show the real total and a
pager (`PageControls`, en + ar, `common.pager.*`). The journal list used to stop at 100 rows with no
sign of the rest. The purchase-order search moved server-side (`q`, over PO number and supplier name,
Zod-validated with the other list params) so it reaches every PO and not only the first 50.
`tests/unit/admin-sibling-meta-lists-use-apigetpage.test.ts` fails if any admin source reads one of
these routes through `apiGet`. The one allowed exception is the OCR upload poll
(`finance/expenses/new`), which reads a single row (`perPage=1`) and never shows a count. Cost if
wrong: a sixth `{ data, meta }` route read through `apiGet` is not caught until it is added to the
guard's route list.
