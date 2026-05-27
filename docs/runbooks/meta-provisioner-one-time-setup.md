# Meta auto-provisioner — one-time Force AI setup

> You do this **once**. After it's done, every new merchant onboard just clicks "Provision automatically" in the FWB admin → MetaCatalogCard and the Commerce catalog + business id + access token fill in automatically.
>
> Without this setup, the button returns `503 PROVISIONER_NOT_CONFIGURED` and the merchant flow falls back to the manual 11-step runbook at `docs/runbooks/wady-aljuz-meta-commerce-setup.md`.

## What you're creating

A Force AI parent Business Manager that owns every merchant's Commerce catalog, with one long-lived system-user access token that the FWB backend uses to provision new catalogs on demand.

Two env vars on Railway:

- `FORCE_AI_META_BM_ID` — the Force AI parent Business Manager id (a number, ~15 digits)
- `FORCE_AI_META_ADMIN_TOKEN` — the never-expires system-user access token

Optional:

- `META_GRAPH_API_VERSION` — defaults to `v21.0`. Bump when Meta deprecates.
- `FORCE_AI_META_PROVISIONER_USER_ID` — system user id, only needed if the admin token is from a different system user than the provisioner

## Step 1 — Create the Force AI parent Business Manager

If one doesn't exist yet:

1. Go to https://business.facebook.com/
2. Click **Create Account**
3. Business name: `Force AI` (or `Force AI Kuwait` — anything you'll recognize in the BM picker)
4. Your name + business email (use `ahmed0montaser@gmail.com` so account recovery is in-org)
5. Confirm via the email link Meta sends

You're now the admin on a fresh BM.

## Step 2 — Note the Business Manager ID

1. https://business.facebook.com/settings → top-left dropdown should show **Force AI** selected
2. Settings → **Business Info** → copy the **Business Manager ID** (15-16 digit number)
3. This goes into `FORCE_AI_META_BM_ID` on Railway

## Step 3 — Create the provisioner system user

1. Business Settings → **Users → System Users** → click **Add**
2. Name: `force-ai-catalog-provisioner`
3. Role: **Admin** (NOT regular — admin is needed for catalog creation under the parent BM)
4. Click **Create System User**

## Step 4 — Generate the never-expires token

Still inside the system user you just created:

1. Click **Generate New Token** → choose the **Force AI** app (or any app under the BM — Meta requires an app context)
   - If you don't have an app yet: Business Settings → **Accounts → Apps → Add → Create New App**. Type: **Business**. Name: `Force AI Provisioner`. Skip everything else (no products needed).

2. Token expiration: **Never** (default for system-user tokens is 60-day; switch to never-expires explicitly)
3. **Permissions / scopes** — check exactly these three:
   - `business_management`
   - `catalog_management`
   - `whatsapp_business_management`
4. Click **Generate Token**
5. **Copy the token IMMEDIATELY.** Meta only shows it once.
6. Save to your password manager labeled `force-ai-meta-admin-token` with today's date.

## Step 5 — Set the two env vars on Railway

```bash
# In the FWB repo root:
railway link  # if not already linked
railway variables --set FORCE_AI_META_BM_ID=<paste-the-BM-id-from-step-2>
railway variables --set FORCE_AI_META_ADMIN_TOKEN=<paste-the-token-from-step-4>
railway redeploy --yes  # so the API picks up the new env
```

Alternative if you prefer the dashboard: Railway → Force Store API service → **Variables** tab → **+ New Variable** for each.

## Step 6 — Smoke test from your laptop

Verify the token works before relying on it:

```bash
TOKEN="<your-token>"
BM_ID="<your-BM-id>"

# Should return { "id": "<BM_ID>", "name": "Force AI", ... }
curl -sS "https://graph.facebook.com/v21.0/${BM_ID}?access_token=${TOKEN}" | jq '.'

# Should list owned catalogs (probably empty for now)
curl -sS "https://graph.facebook.com/v21.0/${BM_ID}/owned_product_catalogs?access_token=${TOKEN}" | jq '.'
```

If either returns a `401` or `OAuthException`, the token is wrong / scopes are missing. Regenerate from step 4.

## Step 7 — Smoke test the FWB button

1. Log into FWB admin as super_admin
2. Pick any store that doesn't yet have a Meta catalog id (or use a throwaway test store)
3. Stores → \<store\> → **WhatsApp Bot** → MetaCatalogCard
4. Click **Provision automatically** → confirm the modal
5. Within ~2-5s the three fields fill in (Catalog ID, Business Account ID, "Token set ✓")
6. Telegram alert fires from `fwb.wbs-integration.provisionMetaCatalog`
7. Verify in Meta Commerce Manager (https://business.facebook.com/commerce) that the new catalog appears under the Force AI BM with the store's name

## Step 8 — Document where the master token lives

Save to your password manager:

- Vault entry: `Force AI — Meta master provisioner token`
- Note: this token is in Railway's env vars on the Force Store API service as `FORCE_AI_META_ADMIN_TOKEN`. Rotating it requires (a) generating a fresh token in Meta BM (re-do step 4), (b) updating the Railway var, (c) `railway redeploy`. No merchant downtime.

## Troubleshooting

| Symptom                                                              | Likely cause                                                                          | Fix                                                                                 |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Button returns 503 `PROVISIONER_NOT_CONFIGURED`                      | env vars not loaded                                                                   | check `railway variables list` shows both keys + `railway redeploy --yes`           |
| Button returns 502 `META_PROVISIONING_FAILED` stage `create_catalog` | token missing `business_management` or `catalog_management` scope                     | regenerate token from step 4 with correct scopes                                    |
| `OAuthException Invalid OAuth access token`                          | system user got disabled OR app the token was generated against got deleted           | regenerate token + ensure system user is still Admin                                |
| Catalog created but not visible in Commerce Manager UI               | UI cache lag                                                                          | refresh, or check `curl /v21.0/${BM_ID}/owned_product_catalogs?access_token=$TOKEN` |
| Button works for some stores but 409 `CATALOG_ALREADY_PROVISIONED`   | merchant already has a catalog id (either previously provisioned or manually entered) | clear the catalog id field on the form → save → then re-provision                   |

## Related

- `apps/api/src/services/meta-provisioner.service.ts` — backend code
- `apps/api/src/routes/wbs-integration.routes.ts` — `POST /:id/integrations/wbs/provision-meta-catalog` endpoint
- `apps/admin/src/app/stores/[id]/wa-bot/MetaCatalogCard.tsx` — UI button
- `docs/runbooks/wady-aljuz-meta-commerce-setup.md` — per-merchant runbook (the "fast path" section now points here)
