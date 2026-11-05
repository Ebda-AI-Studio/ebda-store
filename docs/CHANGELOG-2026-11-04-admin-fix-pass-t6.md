# Admin fix pass, T6 stock / finance / insights / platform / onboarding (2026-11-04)

Placement (what lives where, which buttons)

- Stock: suppliers, purchase orders, adjustments, warehouses have ONE header primary ("ضيف مورد", "أمر شراء جديد", "تعديل مخزون جديد"); row actions are `RowActions` with the destructive item last; PO detail has "استلم البضاعة" in the header and "الغي الأمر" in the "…"; create flows end in `FormFooter`; the store-wide backorder switch moved from a header button to the "…" menu. Adjustments/new defaults to the manual tab, "احفظ كمسودة" is the secondary and "اعتمد التعديل" (irreversible, confirmed) the primary.
- Finance: first tab "الأرباح والمصروفات"; expenses row = next step + "…" (reject, confirmed); bank statements list is a `DataTable` with import in the header and delete in "…"; journal list is a `DataTable`, "New entry" in the header; duplicate in-page titles and `←` back links removed in favour of the `parent` breadcrumb.
- Insights: plain titles; `PageState` (skeleton, error with retry) on dashboard/cohorts/segments, `ErrorState` on funnel.
- Platform: email/sms/webhook queues call `/api/v1/admin/...` (PL-1); native confirm/alert replaced by `useConfirm()` (and toasts) across billing, stock, finance, queues, tax verification, platform settings; `stores/new` puts Cancel in the wizard footer.
- Analytics: cash flow 402/403 renders a locked card (BE:S-4), never an error banner.

Quality

- English feedback literals in stock/finance/insights moved to messages; warehouses and warehouse-stock saves no longer report success when the API refused.
- `amber-*` -> `--warning` tokens; sub-12px text -> `text-xs`; fixed `grid-cols-2/3` -> responsive in StoresGrid, funnel, segments, ai-tools.
- Egyptian register sweep for stock, finance, aiTools, onboarding, billing, account, staff, analytics (fragments `t6.ar.json`).

Rulings

- Ruling T6-1 - The use-confirm handle is named `askConfirm`, not `confirm`. `admin-action-placement.test.ts` matches `confirm(` anywhere and would flag `await confirm({...})`. Cost if wrong: none; the name is local.
- Ruling T6-4 - Count close/reconcile confirmations show line count (close) and differing-line count plus net units (reconcile); no per-line cost exists in the count-session payload. Cost if wrong: the merchant approves a count without seeing its money impact.
- Ruling T6-5 - Card mode below md is done for bank statements, journal, billing charges and the trial balance. The cohort retention matrix and the P&L / balance sheet / tax statements stay as pinned-column scroll grids (rows are compared across columns; card-stacking loses that; the cohort LTV table is already cards). Cost if wrong: those reports need sideways scrolling on a phone.
- Ruling T6-6 - The finance hub gets a divider before the accountant tabs (accounts, journal, reports, bank rec) via `groupStart`. Cost if wrong: one extra divider in the tab strip.
- Ruling T6-3 - Cashflow 403 FORBIDDEN (not only FEATURE_DISABLED) is a locked card on /analytics, because BE:S-4 makes it owner-only. Cost if wrong: a real permission bug on that call would show as a lock instead of an error banner.
