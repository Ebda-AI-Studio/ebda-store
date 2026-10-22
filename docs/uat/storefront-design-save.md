---
feature: storefront-design-save
updated: 2026-06-09
fixes: C1 (cardAspect enum), H13 (social whatsapp wipe), C6 (heroCtaLink XSS), PR-#86/#89/#90
---

# UAT: Storefront Design Save — Smart Palette & Page Builder

**Reviewer account:** store_admin login for Wady Aljuz (or any active test store)
**Pre-conditions:**

- Admin logged in at `store.ebda.app/stores/<id>/`
- Store has at least one product + one category
- Fresh browser session (clear localStorage before starting)
- Preview tab open alongside: `demo-merchant.com` (or preview domain)

**Browser matrix:** Chrome latest · Safari latest · mobile Safari iOS 17+

---

## Golden path — page builder save

1. Navigate to **Admin → Layout** (page builder)
2. Scroll to the **Categories** section
3. Open the **Card Aspect** dropdown → select **Wide** → click **Save**
4. Reload the page → verify the saved value shows **Wide** (not reverted to Square)
5. Open the **Card Aspect** dropdown → select **Ultrawide** → click **Save**
6. Reload → verify **Ultrawide** persists
7. Verify the storefront live preview updates the card aspect accordingly (check live storefront)
8. Open the **Products** section → set Card Aspect = **Wide** → Save → reload → verify persists

---

## Golden path — Smart Palette (PR-#90)

1. Navigate to **Admin → Branding → Theme & Colors**
2. Click **Smart Palette** → pick a new primary color
3. Click **Save**
4. Reload the admin page → verify the selected color persists
5. Navigate to **Admin → Layout** → verify layout keys (card sizes, fonts) from a _previous_ save were NOT wiped
   - This tests the shallow-merge: the Smart Palette PUT touches only color keys, must not drop unrelated layout keys

---

## Golden path — Social Links (whatsapp preservation)

1. Navigate to **Admin → Branding → Contact Info** (or Social Links tab)
2. If there is a WhatsApp number set, note it down
3. Edit only the **Instagram** field (leave WhatsApp field untouched or hidden) → Save
4. Reload → verify the WhatsApp number was NOT cleared
5. If WhatsApp field is visible: clear Instagram entirely → Save → verify WhatsApp still present

---

## Golden path — Hero CTA Link security

1. Navigate to **Admin → Layout → Hero section** (or the hero slide editor)
2. Set a slide CTA link to `javascript:alert(1)` → attempt to Save
3. Verify: **save is rejected** — either a validation error shown in the UI, or a toast "Invalid URL"
4. Set the CTA link to `https://demo-merchant.com/products` → Save → verify accepted and shown on storefront
5. Set the CTA link to `/products?sort=newest` (relative) → Save → verify accepted

---

## Edge cases

- [ ] **page=2 reload after Smart Palette save** — navigate away, return, confirm primary color persists across reload
- [ ] **cardAspect + cardSize saved together** — set aspect=wide AND size=md in same save → reload → both persist (no one clobbers the other)
- [ ] **Social: empty string for a field explicitly cleared** — set Instagram to empty string → Save → reload → Instagram is gone (not empty string stored), WhatsApp unaffected
- [ ] **Hero with no CTA** — leave ctaHref blank → Save → no validation error; storefront renders the slide without a link
- [ ] **Safari on iOS** — verify the dropdown for card aspect works on mobile Safari; no layout save failure
- [ ] **Store with empty layout (new store)** — cardAspect=wide should create a layout row with wide; not 500

---

## Pass criteria

- [ ] `wide` and `ultrawide` card aspects save and survive a reload
- [ ] Smart Palette color save does not wipe typography/card size settings
- [ ] WhatsApp number is never cleared by a social save that doesn't include it
- [ ] `javascript:` CTA link is rejected before storage
- [ ] `https://` and `/relative` CTA links are accepted
- [ ] No console errors during any save flow

> **Note (2026-06-09):** automated regression tests for these fixes are _deferred_ (tracked) until the OS has a runnable test env. Until then, these manual UAT checklists are the verification of record.
