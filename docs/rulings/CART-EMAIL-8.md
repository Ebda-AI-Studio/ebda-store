# CART-EMAIL-8

> Section: 2026-10-16 — Search program, PR 4, Task 13 (quality eval): SEARCH-T13-\*

Ruling CART-EMAIL-8 (2026-10-21, review item 5) - copy: the cart email avoids gendered forms where Egyptian offers a neutral one ("سلتك لسه مستنية", "إتمام الطلب" as the button label, "اشتراكك" not "مشترك", no verb conjugated for the reader), and states the prices are the ones from when the items were added rather than re-pricing at send (no extra read, no extra failure mode). Evidence: `tests/unit/cart-recovery-email.test.ts` (banned masculine-only forms, price label in both languages).
