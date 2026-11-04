# Admin action-placement standard

One rule set for where buttons live on every admin page. Source: the 2026-11-04 admin UX audit (section 2), implemented by the T3 foundation components. Judged on: the merchant knows what the page is for, finds the one main action without hunting, and never meets a destructive button by accident.

## The 11 rules

1. One primary action per view, in the page header, at the inline-end edge (left in RTL). A verb for the page's main job ("منتج جديد", "احفظ"). Never two filled buttons side by side.
2. The header holds at most 1 primary + 1 secondary + a "..." overflow. Export, import, print, reorder, "manage X" and AI helpers go in the overflow or the toolbar under the title.
3. No "back to settings / back to store" in the header. Going back is the hub tab strip or the breadcrumb.
4. Create flows: a sticky footer, primary at inline-end, "إلغاء" as a text button at inline-start. Not in a sidebar column, not in the header.
5. Edit forms longer than one screen: a sticky save bar that appears only when dirty ("فيه تغييرات لسه ما اتحفظتش" + احفظ / تراجع), one Save per page saving every section atomically, a warning before leaving. A per-card Save is allowed only for an independent object with its own lifecycle (a payment provider connection, an API key, a carrier).
6. Row actions: the row itself opens the main action (edit). At most 2 inline buttons plus a "..." menu. Destructive items only in the menu, last, in red, after a divider.
7. Destructive actions never sit next to the primary, always confirm through `useConfirm()` (named object, one-sentence consequence, button named by outcome: "امسح المنتج", not "تأكيد"). Reversible ones offer undo instead. Native `confirm()` / `alert()` are banned.
8. Bulk actions: a bar that replaces the table header when rows are selected ("3 محدد: غيّر الحالة · امسح"), same position on every list.
9. Button labels name the outcome in Egyptian Arabic, 1-3 words ("احفظ", "ضيف منتج", "اشحن الطلب"). Not "تأكيد", "إرسال", "تنفيذ", "إدارة X".
10. Feedback: success is a toast with the object ("اتضاف المنتج"); an error is inline at the field plus a banner with retry. Never `console.error` only, never raw API text.
11. Mobile: the same primary becomes a bottom bar above the safe area (`--bottom-chrome`); targets are at least 44px.

## Components (apps/admin/src/components, hooks)

| Need                                     | Use                                                                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| Page title + primary + secondary + "..." | `<PageHeader title subtitle? primary? secondary? overflow? />`                                                                             |
| Long edit form                           | `<StickySaveBar dirty onSave onReset saving />` (renders nothing while clean)                                                              |
| Create form                              | `<FormFooter primaryLabel cancelHref onPrimary? saving? />`                                                                                |
| Row / header overflow menu               | `<RowActions primary? items=[{label, onSelect                                                                                              | href, destructive?}] />` (destructive sorted last) |
| Confirm a destructive step               | `const confirm = useConfirm(); if (await confirm({ object, consequence, confirmLabel, tone })) ...` (the host is mounted by `AdminLayout`) |
| Loading / error / empty                  | `<PageState loading error empty onRetry>` (a failed fetch is never shown as empty or zero)                                                 |
| Back / next glyph                        | `<ArrowStart/>`, `<ArrowEnd/>` (flip in RTL; no `←` `→` inside strings)                                                                    |
| Plan names in copy                       | `PLAN_LABELS_AR` / `planLabel(code, locale)` via a `{plan}` placeholder; the word is "باقة"                                                |
| API error text                           | nothing to do: `apiRequest` applies `ERROR_AR` by `error.code`; the server's `details.messageAr` wins                                      |

## Enforcement

`tests/unit/admin-action-placement.test.ts` ratchets two rules: no `backToSettings|backToStore` and no native `confirm()/alert()`. Pages that still break them are listed in `admin-action-placement-known-debt.json`; the list may only shrink (a listed file that is clean fails the test). The owner track of each page removes its entries as it adopts the components.

## Hubs

Sales = orders, invoices, returns, then a "customers" group (customers, groups, wholesale, reviews, smart hints). Marketing and offers = coupons, promotions, bundles, loyalty, wallet, then campaigns and the rest. Categories, tags and bulk edit belong to Catalog; delivery and staff to Settings. `components/admin-layout/__tests__/hubs.test.ts` fails if a page directory belongs to no hub or a prefix belongs to two.

## Titles (UX:C-10)

A page title is a noun phrase naming what the merchant manages ("الشحن", "الكوبونات"). No "إعدادات" prefix, no store name, no verb. The title is the TopBar `h1`; the page body does not repeat it. Owner tracks set their titles in their i18n fragment. There is no uniform title key to scan, so this is a convention checked in review, not a lint.

## Dashboard and Settings (T3)

- Dashboard header: one primary, "افتح المحرر" ("شوف المتجر" is the TopBar button). "محتاج تصرّف" tiles come first (new orders, low stock, pending returns, pending reviews) and hide when nothing waits; one failed read never shows as zero. Suspend / activate is in the super-admin DangerZone, not in the quick actions.
- Settings hub: five groups (المتجر، البيع والدفع، الظهور، الفريق والحساب، للمطورين collapsed). `lib/settings-groups.ts` feeds both the cards and the inline-start `SettingsRail` shown on every settings page. Settings pages carry a "الإعدادات" breadcrumb in the TopBar (`parent` prop of `AdminLayout`).

## Ratchets

`tests/unit/admin-copy-ratchets.test.ts` counts stiff Arabic openers per namespace, English literals passed to error setters / toasts, and text under 12px, against `admin-copy-ratchets-baseline.json`. Counts only go down; a track lowers its own numbers when it fixes its pages.
