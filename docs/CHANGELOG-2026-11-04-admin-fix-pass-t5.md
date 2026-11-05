# Admin fix pass, track T5 (UI catalog + sales) - 2026-11-04

Pages: products, categories, tags, bulk, orders, customers, customer-groups, coupons, promotions, bundles, loyalty, wallet.

- Products: new-product form reduced to essentials + "تفاصيل أكتر", default-language-first name, price >= 0.01, no `router.refresh()`, submit stays busy until the route changes (one click = one row), lands on the edit page with a "ضيف المتغيرات" banner; edit gets `StickySaveBar` (dirty only), "شوف في المتجر" + "..." menu; FAQ delete = undo toast; variant / 3D-model / AI-suggestion deletes use `useConfirm`.
- Orders: list header = one primary (طلب تليفون جديد), export in "..."; detail footer = primary + payment action, cancel / refunds / diagnostics / print in "..." (cancel confirms and names the order); cards reordered (items, totals, customer, delivery, payment, shipment, notes, documents); English invoice toasts localised.
- Coupons: load error with retry (not "no coupons"), save and row errors visible, value validated before submit (0 and >100% blocked, hidden for free shipping), row actions = edit + "..." (activate / delete, delete confirms).
- Promotions / bundles: coupon-style `BottomSheet` with a sticky footer, row actions via `RowActions`, empty state with one button, bundles renamed "مجموعات المنتجات" (D8), delete / deactivate via `useConfirm`.
- Categories: "ناقص الاسم بالعربي" chip, row actions via `RowActions`, header without back-to-store. Tags / wallet: empty states with one button. Loyalty: one `StickySaveBar` for the three forms; transactions read error shows a retry. Customers / bulk: back-to-store removed, export in "...".
- i18n only through `apps/admin/src/i18n/fragments/t5.{ar,en}.json`. `tests/unit/admin-action-placement-known-debt.json` shrank by 5 backTo and 7 nativeDialog entries.
- Ruling T5-1 - `loyalty/transactions` "4 controls with no write" are filters: type, dates and customer all feed the query (`fetchTransactions`). Closed as a false positive. Cost if wrong: a filter that does not filter would go unnoticed.
