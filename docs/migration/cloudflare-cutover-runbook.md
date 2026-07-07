# Cloudflare cutover runbook — per-tenant frontend migration (Vercel → Cloudflare-for-SaaS)

> **Status (updated 2026-07-07): CUTOVER COMPLETE, Vercel decommissioned.** The Vercel
> account is cancelled and `VercelDomainService` / the `vercel` `DOMAIN_PROVIDER` branch /
> the admin Domain page's provider switcher have been deleted from the codebase (verified
> zero stores had `Store.domainProvider='vercel'` in prod before removal). Cloudflare-for-SaaS
> is now the sole custom-domain provider — `resolveDomainService()` always returns
> `CloudflareDomainService`. Sections below describing the dual-provider switch (§0.3, §4,
> §5) are kept for migration history but no longer reflect live behavior.

`CloudflareDomainService` no-ops (logs + returns null) until `CF_*` are set.

---

## 0. One-time platform prep (Ahmad)

1. **Enable SSL for SaaS** on the Cloudflare zone that will front the storefronts
   (Cloudflare dashboard → SSL/TLS → Custom Hostnames). Set a **Fallback Origin** —
   a hostname in your zone that points at the deployed storefront Worker
   (e.g. `cf.forcemediakw.com` → the `force-web` worker route). This is the value
   merchants CNAME to, and the value of `CF_FALLBACK_ORIGIN`.
2. **Create an API token** scoped to that zone: `Zone:SSL and Certificates:Edit` +
   `Zone:Zone:Read`. This is `CF_API_TOKEN`. Grab the zone id → `CF_ZONE_ID`.
3. **Set the API env (Railway):**
   - `CF_API_TOKEN`, `CF_ZONE_ID`, `CF_FALLBACK_ORIGIN`
   - (`DOMAIN_PROVIDER` no longer exists as a config key — Cloudflare-for-SaaS is
     the only provider, cutover-complete 2026-07-07.)
4. **Deploy the storefront Worker** (already proven on preview workers, #315/#318):
   ```bash
   bash scripts/cf-setup-local.sh web        # clone the git-ignored CF build files + devDeps
   bash scripts/cf-build.sh web              # OpenNext build (instrumentation.ts workaround built in)
   (cd apps/web && npx wrangler deploy)      # needs a prior `wrangler login`
   ```
   Point the fallback-origin hostname's route at this Worker.

---

## 1. Smoke test on a throwaway domain

Pick a demo store with a disposable custom domain (or attach one). Run:

```bash
CF_API_TOKEN=… CF_ZONE_ID=… CF_FALLBACK_ORIGIN=cf.forcemediakw.com \
DATABASE_URL="$(neonctl connection-string --project-id silent-sun-13697505 \
  --org-id org-lingering-river-25973882 --role-name neondb_owner)" \
bash scripts/cf-migrate-store.sh <demo-slug>
```

The script provisions the CF custom hostname, flips `domain_provider='cloudflare'`,
and prints the CNAME. Set that CNAME at the registrar, then watch the admin
**Domain** page — status flips to **verified** once Cloudflare's HTTP DV issues the
cert (usually minutes). Load the storefront over HTTPS to confirm.

---

## 2. Canary (1–2 low-risk stores, 1–2 weeks)

1. Cut over 1–2 low-traffic real stores the same way.
2. Watch: storefront uptime, Core Web Vitals, and the Cloudflare/Vercel cost split.
   (The readiness doc projects ~$300/mo Vercel → ~$35/mo CF at 100 stores.)
3. Anything wrong → **rollback in one command** (next section). Vercel still has the
   store's domain alias unless you removed it, so rollback is instant.

---

## 3. Batch the rest, then decommission Vercel

Once the canary is healthy, loop the script over the remaining slugs. When the LAST
store is on Cloudflare, you can either flip `DOMAIN_PROVIDER=cloudflare` (so new
provisioning defaults to CF) and/or remove the per-store overrides, then remove the
storefront custom domains from the Vercel project. Keep `apps/api` on Railway and R2
on Cloudflare — this migration is frontend-only.

---

## 4. Rollback (per store) — HISTORICAL, Vercel target no longer available

```bash
CF_API_TOKEN=… CF_ZONE_ID=… DATABASE_URL=… \
bash scripts/cf-migrate-store.sh <slug> --rollback
```

Deletes the CF custom hostname and clears `domain_provider` (falls back to the
platform default, also Cloudflare). Vercel is cancelled, so this no longer reverts
to a working alternate host — it only removes the CF custom hostname. There is
currently no second custom-domain provider to fail over to.

---

## 5. Super-admin UI switch — REMOVED (2026-07-07)

The admin **Domain** page previously showed a super-admin-only **Frontend hosting**
card with a Vercel ⇄ Cloudflare toggle (`PATCH /stores/:id/domain-provider`,
audit-logged). Both the UI card and the API endpoint were deleted once Vercel was
cancelled and confirmed to have zero stores still on it — there is only one provider
left to switch to/from, so the control had nothing left to do.

---

## Reference

- Readiness + cost model: [`cloudflare-readiness.md`](./cloudflare-readiness.md)
- Preview-worker proof + why build files are local-only: [`cloudflare-preview-workers.md`](./cloudflare-preview-workers.md)
- Code: `apps/api/src/services/domain-provider.ts` (resolver),
  `cloudflare-domain.service.ts` (CF Custom Hostnames API),
  `scripts/cf-setup-local.sh` (build files), `scripts/cf-migrate-store.sh` (cutover).
