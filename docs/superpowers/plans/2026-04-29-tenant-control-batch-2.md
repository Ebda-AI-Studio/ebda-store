# Tenant Control Batch 2 — 2026-04-29

> Follow-up batch after the Pages CMS + compareAtPrice ship (`b630ff5`).
> Most of the merchant's wishlist landed in earlier groups (A/C/D/E/G);
> this plan covers the four remaining groups H/I/J/K.

**Goal:** Close the merchant's outstanding requests around variants,
footer polish, push notifications, and R2 hygiene without breaking any
existing functionality.

**Architecture:** Each group is independent — no cross-group ordering
required. Dispatched as parallel subagents; each commits to main with
its own `feat: ... (group <letter>)` message.

**Tech Stack:** Next.js (admin + web), Express/Prisma (api), Cloudflare
R2 storage, OneSignal SDK + REST API.

---

## Already shipped this session (no action)

| Item                                              | Where                 |
| ------------------------------------------------- | --------------------- |
| About / Privacy / Terms editable like a blog      | Pages CMS — `b630ff5` |
| Compare-at price clearable + warn when reversed   | `b630ff5`             |
| Admin + storefront search hits Arabic name fields | Group D — `2c3448d`   |
| Storefront typeahead suggestions                  | Group D — `2c3448d`   |
| Add-to-cart toast everywhere                      | Group E — `ed84043`   |
| Friend's order address validation                 | Group G — `74bef3f`   |
| Pre-header utility bar editable + toggle          | Group C — `a917835`   |
| Footer round 1 (links + copyright editable)       | Group A — `2bfcb8f`   |
| OnboardingChecklist removed                       | `d78c4e1`             |

---

## Group H — Variants: weight/package + per-variant image

**Why:** Merchants selling things by weight (50g/100g/200g) or with
visually different packs need each variant to (a) be selectable as a
distinct option and (b) optionally show its own image when picked.

### Schema

- `ProductVariant.imageUrl: String? @map("image_url")` — optional R2 URL.
- Migration: additive, nullable, no backfill needed.

### API

- `apps/api/src/routes/variant.routes.ts` — accept `imageUrl: z.string().url().nullable().optional()` in create + update Zod schemas.
- `apps/api/src/services/variant.service.ts` — pass through; null clears.
- Public listing endpoints (product detail) must include `imageUrl` on
  the returned variant.

### Admin

- `apps/admin/src/app/stores/[id]/products/[productId]/variants/_components/EditVariantModal.tsx` — add an `<ImageUpload>` row above the price grid. Folder hint: `stores/${storeId}/products`.
- `variants/page.tsx` — include `imageUrl` in form state, send on save.
- Add tip text: "Upload only when this variant looks visibly different from the main product images."

### Storefront

- `apps/web/src/templates/types.ts` — `ProductVariant.imageUrl?: string`.
- `apps/web/src/lib/api.ts` — surface `imageUrl` in the variant type.
- `apps/web/src/app/products/[slug]/ProductDetailClient.tsx` — when a
  variant is selected and has its own `imageUrl`, swap the gallery's
  main image to that URL. Falls back to product images when null.
- `apps/web/src/components/VariantSelector.tsx` — tiny thumbnail next to
  each option pill if `imageUrl` is set, so customers can preview.

### Constraints

- No new deps. Reuse the existing R2 upload helper.
- Variant gallery swap must be reversible (deselect = back to product).

### Commit

`feat: variant images per option (group h)`

---

## Group I — Footer round 2 (logo, socials, WhatsApp, map link)

**Why:** Merchants think the footer "looks small / unfinished". Concrete
items the merchant called out:

1. Logo too small.
2. Section titles should be bold; content underneath should not.
3. Social links use placeholder glyphs — need real Instagram / Facebook
   / X / TikTok / Snapchat / YouTube SVGs.
4. WhatsApp icon hooked to `store.whatsapp` (already in admin settings).
5. Address should be a clickable hyperlink to the merchant's map link.
   Add a settings field for the map URL + a toggle to enable.

### Storefront

- `apps/web/src/components/Footer.tsx` (or per-pack footer if separate) — replace inline text-glyph "social icons" with SVG icons. Use a small inline icon set (Instagram, Facebook, X/Twitter, TikTok, Snapchat, YouTube, WhatsApp) — paths from Simple Icons CDN copied locally so no runtime dep is added.
- WhatsApp link target: `https://wa.me/<digits>` from `store.whatsapp`. Hide entirely when empty.
- Logo: bump from `h-12` to `h-16 sm:h-20` and remove the visual cap.
- Section titles: confirm `font-semibold text-foreground` (or upgrade to `font-bold`); body text is `text-muted-foreground font-normal`.
- Address: when `store.settings.addressUrl` is set AND `store.settings.addressLink === true` (default true when URL present), render `<a href={addressUrl} target="_blank" rel="noopener">` around the address text.

### Admin

- `apps/admin/src/app/stores/[id]/settings/page.tsx` — new "Map link" row under the existing address field: URL input + "Make address clickable" toggle.
- Save under `store.settings.addressUrl` + `store.settings.addressLink`.
- En + Ar copy.

### Constraints

- Don't add a runtime icon dep. Inline SVG paths.
- Empty social slot ⇒ icon hidden, not rendered as a broken link.
- Stores without `addressUrl` ⇒ address renders as plain text (today's behavior).

### Commit

`feat: footer round 2 (logo, social svgs, whatsapp, map link) (group i)`

---

## Group J — OneSignal push end-to-end

**Why:** The platform has `apps/api/src/routes/onesignal.routes.ts` and a
`OneSignalInit` admin component but the feature is not actually wired:
storefront doesn't tag devices with `storeId`, and merchants can't send
broadcasts.

### Audit + verify

- Confirm `ONESIGNAL_APP_ID` + `ONESIGNAL_REST_API_KEY` are set on
  Railway. If missing, add to env reference in CLAUDE.md.
- Verify `OneSignalInit` mounts on storefront (probably under
  `apps/web/src/app/layout.tsx` or per-store layout). If it's only in
  admin, mount it on storefront too — that's where customers consent.

### Storefront

- After OneSignal user accepts permission, call
  `OneSignal.User.addTag('storeId', store.id)`. This is what scopes the
  filter in the REST broadcast call.
- Hide the prompt entirely when the merchant disabled push in settings.

### Admin

- `apps/admin/src/app/stores/[id]/notifications/page.tsx` — extend with
  a "Send broadcast" composer card. Fields: title (en + ar), body
  (en + ar), optional URL (deep link to a product/category/page).
- POST → `/api/v1/admin/stores/:storeId/push/broadcast` (new endpoint
  in `onesignal.routes.ts`) which calls OneSignal REST with
  `filters: [{ field: 'tag', key: 'storeId', relation: '=', value }]`.
- Show last 10 broadcasts with delivered count + clicked count via a
  fetch to `/notifications/<id>` on OneSignal.

### Constraints

- Per-store filtering MUST work — never broadcast across tenants.
- If env vars are missing, the admin composer renders a config note
  rather than crashing.
- Use existing `Toast` for success/error feedback.

### Commit

`feat: onesignal push notifications end-to-end (group j)`

---

## Group K — R2 hygiene + per-store folder structure

**Why:** Merchant wants to see per-store assets in Cloudflare dashboard
without leakage. Today uploads are flat-ish.

### New keys

- All future uploads land in `stores/<storeId>/<asset>/<filename>`
  where `<asset>` is one of:
  - `logos` (store + brand logos)
  - `products` (product + variant images)
  - `categories` (category covers)
  - `pages` (CMS page covers)
  - `branding` (theme assets)
  - `hero` (homepage hero slides)

### API

- `apps/api/src/services/upload.service.ts` (or wherever the `Key:` is
  built) — accept a `storeId` + `folder` and compose
  `stores/${storeId}/${folder}/${nanoid}-${safeName}`.
- `apps/api/src/routes/upload.routes.ts` — pass `storeId` (from auth or
  query) + `folder` (already a query param) into the service.

### Admin

- `apps/admin/src/components/ImageUpload.tsx` — every call site that
  passes `folder` — keep doing so; the folder is now relative
  ("products", "categories"). The full key composition happens server
  side.

### Backwards compatibility

- Existing image URLs are stored in the DB as full R2 URLs. Do NOT
  rename existing keys — image URLs would 404. Just direct new uploads
  to the namespaced path.

### Optional cleanup script

- `scripts/r2-orphan-audit.ts` (new) — list R2 objects that are NOT
  referenced anywhere in the DB. Print stats (count, total bytes).
  No deletion. Merchant runs manually after reviewing.

### Constraints

- Existing URLs MUST keep resolving.
- Don't add a new dep. The existing `@aws-sdk/client-s3` already speaks
  to R2.

### Commit

`feat: per-store r2 folders + orphan audit script (group k)`

---

## Dispatch shape

Run H, I, J, K as parallel subagents. None block each other.
After each agent's commit, controller pulls latest, marks the task done,
appends a one-liner to `MEMORY.md`'s active plan entry.

## Self-check

- [x] Schema migrations are additive (variant `image_url` is nullable).
- [x] No backwards-incompatible R2 key renames.
- [x] Each group has a dedicated commit + En + Ar i18n.
- [x] Tenant scoping (storeId) is enforced everywhere assets land.
