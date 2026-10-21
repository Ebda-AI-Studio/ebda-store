---
feature: store-creation
updated: 2026-05-24
---

# UAT: Store Creation (Super-Admin Flow)

**Reviewer account:** see 1Password vault entry `store-creation-uat`  
(super_admin role; email/password in vault)  
**Pre-conditions:**

- Preview/staging admin at `https://<preview-admin-domain>/`
- A spare custom domain for testing (e.g. `uat-test-store.ebda.app` — a real DNS record pointing at the Cloudflare Workers preview, OR any slug-based access)
- Cloudflare R2 staging bucket accessible for logo upload
- Test store from a previous run deleted (or use a fresh slug)

**Browser matrix:** Chrome latest · Safari latest · mobile Safari iOS 17+

---

## Golden path

1. Sign in as super_admin
2. Navigate to **Stores** → click **New Store**
3. Fill in store details:
   - Store name (EN): `UAT Test Store`
   - Store name (AR): `متجر اختبار`
   - Slug: `uat-test-store`
   - Owner email: assign to a test store_admin account
4. Click **Create** → verify redirect to the new store's settings page within 2s
5. Navigate to **Branding** tab → upload a test logo (PNG ≤2MB)
6. Verify logo uploads to R2 (URL shown in field; no error)
7. Verify logo renders in the admin branding preview
8. Navigate to **Domain** tab → enter `uat-test-store.ebda.app` (or a test slug domain)
9. Click **Save Domain** → verify no error (domain provisioning may be async; note it is queued)
10. Navigate to **Products** → click **New Product**
11. Fill in: name `Test Product`, price `5.000`, stock `10`, category (create if needed)
12. Click **Publish** → verify product is active
13. Open storefront via the store's slug URL: `https://<web-preview>/<slug>` or custom domain
14. Verify storefront loads with: correct store name, uploaded logo, and the test product visible
15. Verify store name in browser `<title>` matches the configured store name
16. Verify Arabic locale loads: switch to AR → store name and product name appear in Arabic if set

---

## Edge cases

- [ ] **Duplicate slug** — attempt to create a second store with slug `uat-test-store` → API returns 409 with "slug already taken" message; form shows inline error
- [ ] **Invalid logo type** — upload a `.pdf` file as logo → client-side validation rejects it before upload; no R2 write attempted
- [ ] **Logo too large** — upload a >10MB image → validation error shown; no partial upload to R2
- [ ] **Slug with uppercase/special chars** — type `UAT Test!` as slug → field auto-converts to `uat-test` or shows validation error (no uppercase, no spaces, no special chars allowed)
- [ ] **Store visible only to its owner** — sign in as a different store_admin (not the assigned owner) → the UAT Test Store should NOT appear in their store list (RLS isolation)
- [ ] **Mobile Safari** — complete steps 1-13 on iPhone Safari → form inputs usable, logo upload works (camera roll or file picker), storefront renders correctly

---

## Teardown

After sign-off, delete the UAT test store to keep the test DB clean:

- Admin → Stores → find `uat-test-store` → Delete → confirm
- Verify store is removed from list and storefront returns 404

---

## Sign-off

| Role         | Name             | Date         | Notes                                      |
| ------------ | ---------------- | ------------ | ------------------------------------------ |
| Engineer     | \***\*\_\_\*\*** | **\_\_\_\_** |                                            |
| Merchant rep | \***\*\_\_\*\*** | **\_\_\_\_** | only required before first merchant launch |
