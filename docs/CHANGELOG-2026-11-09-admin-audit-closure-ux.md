# Admin audit closure, UX rows (2026-11-09)

Placement and flows

- Native dialogs: `SmartPaletteModal` asks through `useConfirm()`; `ZoneEditor` shows an inline alert; the native-dialog debt list is empty. The action-placement test also fails a header `actions={...}` slot with more than one filled button (UX:U-1).
- `/template` redirects to `/builder` (UX:T-1); the settings card and palette point there.
- Dashboard: one next-step slot (setup guide, else order-alerts prompt, else stale gold rate) via `NextStepSlot` (UX:D-5). Finance hub: the ledger tabs carry the caption "للمحاسب" (UX:FN-2).
- Gated states: `/payment-abandonments` is plan-gated by the store layout like the other paid routes; the wholesale messages name the plan from the plan table (UX:S-6).
- Resend/verify: a 429 shows the rate-limit text on `VerifyGate` and `/verify-email` (UX:S-5); wallet and tags use `DataTable` card mode (UX:M-2); `stores/[id]/ai-usage` uses `PageState` with a retry (UX:CU-1); tax rate form grid is single-column on phones (UX:M-3); announcement and SEO keep their real subtitle while loading (UX:S-12).

Copy

- No hard-coded plan names in ar/en messages: `{plan}` / `{plans}` / `{trialPlan}` fed by `lib/plan-labels.ts` (UX:C-5, QA P2-9); `billingEvents.plans` removed.
- English feedback literals (affiliate events, inventory, finance dashboard, super-admin store settings toasts) moved to messages; the C-2 baseline is empty.
- Titles are noun phrases (products, SEO "ظهور في جوجل", tax "الضريبة"); product SEO section "ظهور في جوجل"; card-frame dedup copy is Egyptian and the dead `uppercaseStyle` messages are gone (UX:C-10, PE-4, TX-2, B-2).
- `stores.dashboard.*` is Egyptian; `admin-egyptian-register.test.ts` fails on any new formal opener ("يجب", "سيكون", "ليتمكن"...) and keeps a shrink-only legacy list (UX:C-4).
- No `←` / `→` inside messages (UX:R-1; pagination uses `ArrowStart` / `ArrowEnd`).

Look

- Text below 12px outside charts is `text-xs`, baseline empty (UX:M-4). `amber-*` classes replaced by the `--warning` tokens, with a test (UX:C-7).

Rulings

- ADMIN-CLOSE-UX-1 (PE-2), -2 (TX-1), -3 (ST-2), -4 (residuals): see `docs/rulings/`.
