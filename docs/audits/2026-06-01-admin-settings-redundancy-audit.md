# Admin Settings Redundancy & Consolidation Audit — 2026-06-01

Read-only audit of every admin settings/config surface, against the north-star:
**"group everything related in one place so it's easy to edit without page-hopping —
the easier things are to find and edit, the more competitive value Force AI has."**

This session already consolidated nav/footer/category/social-SEO. This report maps
what REMAINS: duplicate fields, conceptual overlap, and orphaned (unreachable) pages.

---

## 1. Sidebar hub structure

- Nav builder: `apps/admin/src/components/admin-layout/buildStoreAdminNav.ts`
- Hub defs (tabs + urlPrefixes): `apps/admin/src/components/admin-layout/hubs.ts`

8 store-admin hubs: Dashboard, Catalog (Products/Page Builder/Content/Blog/Floating Widget),
Sales (Orders/Customers), Stock (8 sub-pages), Finance (Dashboard/Accounts/Journal/Expenses/Reports),
Analytics (Overview/Insights×5), Marketing (AI Tools/AI Usage/Notifications/Newsletter/Abandoned Carts/Marketing Pixels/Affiliates),
Settings (card-grid landing), Manage Features (super-admin).

Settings cards active 2026-06-01: branding, categories, seo, domain, paymentSettings,
shipping, taxSettings (gated), pwaSettings (gated), template, language, whatsapp.

---

## 2. Redundancy matrix — same data editable in 2+ places

| #   | Field / data key                                                   | Edited in                                                                                                                     | Saves via                                                | Recommended single home                                                                                                                                 |
| --- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | `socialLinks.{instagram,facebook,tiktok,youtube,twitter,linkedin}` | Branding→Social **and** SEO page (reads all 6, saves only wikidata/wikipedia)                                                 | `PUT /stores/:id/social`                                 | **Resolved this session** — but SEO page still loads 6 dead social state vars; remove them (keep wikidata/wikipedia only).                              |
| R2  | `theme.primaryColor` / `secondaryColor` / theme keys               | Branding→Theme **and** Page Builder Smart Palette                                                                             | `PUT /stores/:id/theme`                                  | Branding→Theme primary; Page Builder stages + fires only on Save. Acceptable; add a "edit in Branding→Theme" hint.                                      |
| R3  | `blogEnabled` (Store column)                                       | Branding→Theme, useBranding hook, Features matrix                                                                             | `PUT /stores/:id`                                        | Branding→Theme (merchant) + Features (super-admin override). Fine.                                                                                      |
| R4  | `settings.navMenu` (header nav)                                    | standalone `/navigation` **and** Page Builder (embedded)                                                                      | `PUT /stores/:id`                                        | **Page Builder** (done — Settings card removed). Both load independently → last-save-wins overwrite risk.                                               |
| R5  | `settings.footerLinks`                                             | standalone `/pages` **and** Page Builder (embedded)                                                                           | `PUT /stores/:id`                                        | **Page Builder** (done — card removed). Same overwrite risk as R4.                                                                                      |
| R6  | **Announcement bar**                                               | standalone `/announcement` (content: text/colors-as-hex) **and** Page Builder card (chrome: visibility/padding/token-bgColor) | `/stores/:id/announcement` vs `/admin/stores/:id/layout` | **#1 remaining split-brain.** Two APIs, two schemas, both set the bar's bg color (hex vs token). Merge content into the Page Builder Announcement card. |
| R7  | **Hero content**                                                   | standalone `/hero` (legacy Store-column fallback text) **and** Page Builder Hero (slides)                                     | `PUT /stores/:id` vs `/admin/stores/:id/layout`          | Page Builder owns slides; embed the fallback-copy fields as a sub-form there, make `/hero` a redirect.                                                  |
| R8  | `store.description` / `descriptionAr`                              | Branding→Identity (writes); PWA (reads to prefill)                                                                            | `PUT /stores/:id/branding`                               | Not a true conflict (one-directional copy); note PWA desc won't auto-update after edit.                                                                 |
| R9  | `store.logo` / `favicon` / `theme.footerLogo` / PWA icons          | Branding→Identity, Branding→Theme, PWA (prefill)                                                                              | multiple                                                 | Conceptually distinct images but split across 3 tabs; a "Logo & Icons" grouped section would aid discoverability.                                       |
| R10 | `store.whatsapp` (display #) vs WhatsApp integration               | Branding→Contact vs WhatsApp→Connection                                                                                       | different                                                | Genuinely different data (display vs API key). No conflict.                                                                                             |
| R11 | `emailSenderLocalPart` vs email sender domain                      | SEO page vs Domain page                                                                                                       | `PUT /stores/:id/seo` vs `/email-sender/provision`       | Move `emailSenderLocalPart` into Domain page (all email-sender config in one place).                                                                    |

---

## 3. Orphaned / hard-to-reach pages

Exist by URL, no nav/card entry point (after this session's card removals):

| Page                                                                                                | Path                    | Severity                                                                |
| --------------------------------------------------------------------------------------------------- | ----------------------- | ----------------------------------------------------------------------- |
| **Reviews**                                                                                         | `reviews/page.tsx`      | **HIGH — fully orphaned, no discovery path**                            |
| **Coupons**                                                                                         | `coupons/page.tsx`      | **HIGH — fully orphaned for stores with coupons enabled**               |
| **Loyalty**                                                                                         | `loyalty/page.tsx`      | **HIGH — fully orphaned for stores with loyalty enabled**               |
| **Returns**                                                                                         | `returns/page.tsx`      | **HIGH — fully orphaned**                                               |
| **Announcement**                                                                                    | `announcement/page.tsx` | **HIGH — edits live content, no entry point**                           |
| Hero (legacy)                                                                                       | `hero/page.tsx`         | Medium — deprecation notice, still works                                |
| Navigation / Pages (footer)                                                                         | `navigation`, `pages`   | Medium — embedded in Page Builder; standalone has no card (intentional) |
| `/bulk`                                                                                             | `bulk/page.tsx`         | Medium — only reachable from Products toolbar                           |
| `/inventory`, `/wa-bot`, `/wa-templates`, `/wa-order-updates`, `/payment-link`, `/integrations/wbs` | redirects               | Low — redirect correctly                                                |

---

## 4. Sidebar grouping gaps vs the north-star

1. **Sales hub missing post-sale ops** — Reviews/Returns/Coupons/Loyalty are post-sale/retention tools but not in Sales. A merchant who processed an order expects Returns + Reviews beside Orders.
2. **Marketing hub missing coupons + loyalty** — both are retention/marketing tools with no hub entry.
3. **Settings is a flat card grid** — fine at ~11 cards; sub-tab grouping (Identity / Commerce / Growth / Integrations) helps as it grows.
4. **Announcement/Hero/Nav orphaned from the Page Builder flow** a merchant would expect them in.

---

## 5. Prioritized consolidation plan

### P1 — CRITICAL (blocks merchant discovery) — effort S

- **P1-A** Add Reviews, Returns, Coupons, Loyalty as tabs under **Sales hub** (pages built; just nav wiring in `hubs.ts` + `buildStoreAdminNav.ts`).
- **P1-B** Re-surface Announcement: re-add a Settings card OR (better) embed content into the Page Builder Announcement card.

### P2 — HIGH (split-brain data) — effort M

- **P2-A** Merge Announcement content + chrome into ONE Page Builder card / endpoint (kills R6 hex-vs-token confusion).
- **P2-B** Move `emailSenderLocalPart` from SEO → Domain (R11).
- **P2-C** Embed Hero fallback-copy into Page Builder Hero section; make `/hero` a redirect (R7).

### P3 — MEDIUM (polish) — effort S–M

- **P3-A** Remove the 6 dead social state vars from the SEO page (R1 tail).
- **P3-B** Group logo/favicon/footerLogo/PWA-icons into a "Logo & Icons" section (R9).
- **P3-C** Status-chips on Settings landing for enabled-but-buried features (per global discoverability rule #8).
- **P3-D** Settings sub-tab grouping when card count grows.

### P4 — LOW (cleanup) — effort XS

- **P4-A** Add `/announcement`, `/hero`, `/navigation`, `/pages` to Settings hub `urlPrefixes` so the sidebar lights up on those pages.
- **P4-B** Give `/bulk` a proper entry point (dashboard quick-action or Catalog tab).

---

## Key files

- Settings landing: `apps/admin/src/app/stores/[id]/settings/page.tsx`
- Hubs / nav: `apps/admin/src/components/admin-layout/{hubs.ts,buildStoreAdminNav.ts}`
- Page Builder: `apps/admin/src/app/stores/[id]/page-builder/page.tsx`
- SEO (dead social state): `apps/admin/src/app/stores/[id]/seo/page.tsx`
- Branding: `apps/admin/src/app/stores/[id]/branding/` (+ `_hooks/useBranding.ts`)
- Orphaned: `reviews/`, `coupons/`, `loyalty/`, `returns/`, `announcement/`, `hero/`
