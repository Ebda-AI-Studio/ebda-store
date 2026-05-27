# Wady Aljuz Meta Commerce setup + Phase E cutover

> Phase E of the WhatsApp Native Catalog Bot plan (`docs/superpowers/plans/2026-05-25-whatsapp-native-catalog-bot.md`). Phases 0/A/B/C/D shipped to prod 2026-05-27. This runbook is what Ahmad executes manually to flip the first merchant (Wady Aljuz) over to the new bot.

## Pre-flight — what's already deployed

- **FWB API + admin** are live with the bot config UI (`MetaCatalogCard`, `BotModeCard`, `ServiceMenuCard` in the WhatsApp Bot admin section)
- **WBS backend + worker** are live with the bot service router (`bot-service-router.js`) and Meta Commerce Catalog publisher (`metaCatalogService.js`)
- `Store.bot_mode` defaults to `'legacy_chat'` for every existing merchant; Wady Aljuz currently runs the OLD bot path
- `Store.meta_catalog_id`, `Store.meta_business_id`, `Store.meta_access_token` are nullable + encrypted at rest
- An admin save that flips `botMode` to `native_catalog*` now fires a Telegram alert (see `wbs-integration.routes.ts`)

## Step 1 — Create Meta Business Manager account (if not already)

If Force AI doesn't already have a Meta Business Manager for the merchant, create one at https://business.facebook.com/. Use the Force Media admin email so account recovery is in-org.

For Wady Aljuz specifically: the merchant likely already has a Meta Business account tied to their existing Facebook/Instagram page. **Get them added as an admin on a Force AI managed Business Account** rather than asking them to grant Force AI access to theirs — keeps catalog control with us.

## Step 2 — Create a Commerce Catalog

1. Meta Business Manager → Catalog Manager (or https://business.facebook.com/commerce_manager)
2. **Create catalog** → choose **"E-commerce"** as the type
3. **Catalog name**: `Wady Aljuz` (must match the storefront brand — appears in WhatsApp UI)
4. **Owner**: the Business Manager from Step 1
5. **Add items source**: "Upload products" (we'll publish via API; don't connect a feed)

Note the **Catalog ID** (it's a 15-16 digit number). You'll paste this into the FWB admin in step 5.

## Step 3 — System User access token

API publishing needs a long-lived token (regular user tokens expire in 60 days, system user tokens don't).

1. Business Manager → Business Settings → **System Users** → "Add" → name it `wady-aljuz-catalog-publisher`, role `Admin`
2. Assign Assets:
   - **Catalog**: Wady Aljuz catalog (from Step 2), permission `Manage catalog`
   - **WhatsApp Account**: Wady Aljuz WABA, permission `Manage`
3. **Generate Access Token**:
   - Token type: **never expires** (system user tokens default to 60-day but you can switch to never-expires for production)
   - **Scopes required**: `catalog_management`, `whatsapp_business_messaging`, `whatsapp_business_management`
4. **Copy the token IMMEDIATELY** — you can't see it again. Save it to your password manager labeled "wady-aljuz-meta-system-user-token YYYY-MM-DD".

## Step 4 — (Optional) Pre-flight test via curl

Verify the token works before pasting it into FWB admin:

```bash
TOKEN="<token from step 3>"
CATALOG_ID="<catalog id from step 2>"

curl -sS "https://graph.facebook.com/v21.0/${CATALOG_ID}?access_token=${TOKEN}" | jq '.'
# Expect: { "id": "<CATALOG_ID>", "name": "Wady Aljuz", ... }

# Test product upsert (use a dummy retailer_id; will create a placeholder)
curl -sS -X POST "https://graph.facebook.com/v21.0/${CATALOG_ID}/products" \
  -d "access_token=${TOKEN}" \
  -d "retailer_id=test-product-001" \
  -d "name=Test" \
  -d "description=Pre-flight test" \
  -d "url=https://wadyaljuz.com" \
  -d "image_url=https://wadyaljuz.com/og-image.png" \
  -d "category=ARTS_AND_ENTERTAINMENT" \
  -d "price=100" \
  -d "currency=KWD" \
  -d "availability=in stock" \
  -d "condition=new" \
  -d "brand=Wady Aljuz" \
  | jq '.'
# Expect: { "id": "<product-fb-id>" }

# Clean up the test product
curl -sS -X DELETE "https://graph.facebook.com/v21.0/<product-fb-id>?access_token=${TOKEN}" | jq '.'
```

If any of these fail with a 403/401/400, fix the system-user permissions before continuing — don't paste a broken token into prod.

## Step 5 — Paste credentials into FWB admin

1. Log in as super_admin at https://app.forcemediakw.com
2. Navigate to **Stores → Wady Aljuz → WhatsApp Bot** (sidebar)
3. **MetaCatalogCard**:
   - **Meta Business Account ID**: from Business Manager → Business Info
   - **Meta Catalog ID**: from Step 2
   - **Access Token**: paste from Step 3
   - Click **Save**. The token is encrypted at rest (`encryption.encrypt()` in `wbs-integration.routes.ts:417`).
4. **Verify**: the card now shows `hasMetaToken: true` and the Catalog Status badge fetches live (calls Meta `GET /<catalog_id>` once)

## Step 6 — Trigger initial product sync

The bulk sync is fan-out via Inngest — each product fires a `product.upserted` event which `product-meta-sync.ts` handles by POSTing to the WBS `metaCatalogService.upsertProduct`.

**Two ways to trigger:**

**(a) UI button (recommended):** In the same WhatsApp Bot admin tab, find **"Sync products to Meta Commerce"** button → click → confirm modal → fires `bulk-product-meta-sync` Inngest function. Progress shows in toast.

**(b) Manual one-product test first:** Pick one product in the admin → edit + save (no changes needed, just trigger the `product.upserted` event) → check Inngest dashboard at https://app.inngest.com → confirm `product-meta-sync` ran and posted to WBS → check Meta Commerce Manager → product should appear within ~30s.

**Expected time:** Wady Aljuz has ~60 products. At 1 product/second (conservative — Inngest fan-out is concurrent), full sync completes in ~60-120s. Long-running merchants might take longer; watch the Inngest dashboard.

## Step 7 — Submit catalog for review (Meta human review)

Meta requires manual review before a catalog can be used in WhatsApp interactive messages.

1. Meta Commerce Manager → Wady Aljuz catalog → **Settings** → **Catalog review**
2. Submit. Approval typically takes **24-48 hours**.
3. Common rejection reasons:
   - Missing product images → ensure every product has `image_url` (Force Store auto-passes `product.images[0].url`)
   - Generic/placeholder descriptions → if any product still has a SEO-only description, fill the meta description AND product description before sync
   - Restricted category mismatch → Wady Aljuz is mostly spices / herbs / food; should map to `FOOD_BEVERAGES_AND_TOBACCO` category in Meta. Verify the `category` field is being passed correctly (in `metaCatalogService.upsertProduct`).

**You'll get a Telegram alert in the meantime** when the bot mode flips (step 9 below). Don't flip the bot mode until Meta approves the catalog.

## Step 8 — (Wait) Meta approval

Watch your email for the approval notification from Meta. If rejected, fix the reason, re-submit, repeat.

## Step 9 — Flip bot mode (the cutover)

Once Meta approves the catalog:

1. FWB admin → Wady Aljuz → WhatsApp Bot → **BotModeCard**
2. Change `bot_mode` dropdown from `legacy_chat` to **`native_catalog_with_gemini_agent`**
3. Click **Save**.

**What happens internally:**

- `Store.bot_mode` row updates in DB
- A Telegram alert fires from `fwb.wbs-integration.botMode` source (see `wbs-integration.routes.ts:447-462`):
  ```
  🟦 [INFO] Store flipped to native_catalog_with_gemini_agent
  store=Wady Aljuz · slug=wady-aljuz · env=production
  Bot mode changed from legacy_chat to native_catalog_with_gemini_agent.
  Verify Meta Commerce catalog is approved + access token still valid.
  ```
- On the next inbound WhatsApp message to Wady Aljuz, WBS's `bot-service-router.js` reads `Store.bot_mode` (via the wa-bridge fetch) and routes through the new state machine: greeting → language → service menu → catalog browse → cart → address → payment → confirmation

## Step 10 — Smoke test

Use the Force Media test WhatsApp number. Send `Hi` to Wady Aljuz's WhatsApp number.

Run through the entire flow:

1. Greeting message (bilingual)
2. Language pick (tap Arabic or English button)
3. Service menu (4 buttons)
4. Tap "Order Now" / "اطلب الآن"
5. Tap "View Catalog" → WhatsApp opens the native catalog inline
6. Pick 1-2 products → tap "Add to cart"
7. Tap "Checkout" → confirm cart
8. Address pick — first time will prompt "Enter new address"; second order will list saved
9. Payment method (Online or COD)
10. Order summary → confirm

**Each step has documented expected timing in** `docs/uat/whatsapp-bot-latency-baseline.md`. If you see >3s per step, log into Sentry to find the slow span.

Capture screenshots into `docs/uat/whatsapp-native-catalog-bot-wady-aljuz-smoke.md` (template below).

## Step 11 — 24-hour monitor

Watch for the first day after the flip:

- **Sentry** project: `force-api` filter by tag `store_slug:wady-aljuz` — any 4xx/5xx on the wa-bridge endpoints?
- **Telegram channel**: any P0/P1 alerts (queue-depth-watch, force-api-heartbeat, etc.)
- **Inngest dashboard**: failures on the `bot-service-router` function?
- **Real customer orders**: open the WBS inbox at https://ws.forcemediakw.com — are conversations completing? Compare to yesterday's pre-cutover volume

If anything's worse than the legacy bot, **roll back**:

1. FWB admin → Wady Aljuz → WhatsApp Bot → BotModeCard
2. Change `bot_mode` back to `legacy_chat`
3. Save. Another Telegram alert fires confirming the rollback.

Customer experience returns to the previous bot path immediately on the next message (no state to clean up; WBS routes on `bot_mode` per-message).

## Rollback procedure (mid-cutover)

If something goes wrong during steps 5-9 (token rejected, sync failed, etc.):

| Step where it broke           | Rollback                                                                                                                                                                      |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Token paste (step 5)          | Click **Clear** on the access token field → save. Nothing was sent to Meta yet.                                                                                               |
| Initial product sync (step 6) | Stop the Inngest fan-out — pause the function in Inngest dashboard. Products may be partially uploaded; that's OK, Meta won't show them until catalog is reviewed + approved. |
| Catalog rejected (step 7)     | No rollback needed — fix the issue, resubmit. Bot mode is still `legacy_chat`.                                                                                                |
| Bot mode flip (step 9)        | Switch `bot_mode` back to `legacy_chat`. Customers on the next message get the old flow.                                                                                      |

## Future: scaling beyond Wady Aljuz

Each new merchant repeats steps 1-10. To scale:

- Add a `force-store-admin → bulk Meta provisioning` flow that ties Force Store onboarding to Meta catalog creation in one click (manual today, automatable when catalog count reaches ~10)
- Build a `meta-catalog-health` background job that periodically GETs the catalog status + alerts if `review_status` regresses (Meta can demote a catalog post-approval if products violate policy)
- Add a Telegram alert when product sync fails for a merchant (currently the failure shows in Inngest dashboard only)

## Related docs

- `docs/superpowers/plans/2026-05-25-whatsapp-native-catalog-bot.md` — full plan (Phases 0/A/B/C/D shipped, this is Phase E)
- `docs/superpowers/specs/2026-05-25-whatsapp-native-catalog-bot-design.md` — original design spec
- `docs/uat/whatsapp-bot-latency-baseline.md` — latency baselines from Phase 0 measurement
- `docs/uat/whatsapp-native-catalog-bot-wady-aljuz-smoke.md` — Phase E.3 smoke screenshots (create when running step 10)
- `docs/runbooks/SUPER-ADMIN-PLAYBOOK.md` — operational reference for plan / feature toggles
