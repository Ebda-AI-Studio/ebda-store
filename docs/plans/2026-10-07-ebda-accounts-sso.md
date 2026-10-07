# Ebda Accounts — one login across store., whatsapp., crm.ebda.app (design only)

Date: 2026-10-07 · Status: DESIGN, nothing built · Input for: Ebda WhatsApp, Ebda CRM · Related: Ruling HOST-STORE-1 (`docs/RULINGS.md`)

## Why now

Ebda Store moved to `store.ebda.app` (HOST-STORE-1). Ebda WhatsApp (`whatsapp.ebda.app`) and Ebda CRM (`crm.ebda.app`) are coming next. Without a shared identity each product grows its own users table, password reset, MFA and session code, and a merchant who buys two products has two accounts that drift. One login, decided before product #2 ships, is cheap; retrofitting it after two user tables exist is a migration.

## Today (what exists)

- `api.ebda.app` (`apps/api`) owns users, sessions and MFA for Ebda Store: 30-min access JWT (`token`, `jti` denylist, `tv` bulk revocation) + 365-day rotating refresh token (`refresh_token`, DB-backed `refresh_tokens`, reuse detection → family revoke). Cookies are scoped to the API host, `SameSite=None; Secure`; frontends authenticate client-side via `AuthProvider` and send `credentials: 'include'` (CLAUDE.md "Cross-origin auth").
- The tenant is a `Store`; `store_staff` links users to stores; strict RLS keys on `app.current_store_id` / `app.current_user_id`.

## Target

| Host                | Role                                                                                          |
| ------------------- | --------------------------------------------------------------------------------------------- |
| `accounts.ebda.app` | The ONLY place a person types a password / OTP / MFA code; owns sign-up, reset, MFA, sessions |
| `store.ebda.app`    | Ebda Store (relying party)                                                                    |
| `whatsapp.ebda.app` | Ebda WhatsApp (relying party)                                                                 |
| `crm.ebda.app`      | Ebda CRM (relying party)                                                                      |

`accounts`, `id`, `hub`, `store`, `whatsapp`, `crm`, `erp` are reserved slugs (chore/product-ebda-store), so no merchant can take them.

## Model

1. **Identity (global, not tenant-scoped):** `User` (email, phone, password hash, MFA factors, locale). One row per human across all products.
2. **Organization = the business** (new, above `Store`): the billing + ownership unit shared across products. `Membership(user, organization, role)`. A product's tenant hangs off it: `Store.organizationId`, later `WhatsAppWorkspace.organizationId`, `CrmWorkspace.organizationId`. Existing stores get one organization each in a backfill; `store_staff` stays the per-store grant.
3. **Entitlements per product:** `OrganizationProduct(organization, product: store|whatsapp|crm, plan, status)`. A login is valid everywhere; access to a product is an entitlement check, not a separate account.

## Session flow (OIDC-shaped, our own issuer first)

- `accounts.ebda.app` is an OpenID Connect issuer (authorization-code + PKCE). Each product is a registered client with an exact redirect URI allowlist (`https://store.ebda.app/auth/callback`, …). No wildcard redirects.
- Central session: a first-party, host-only cookie on `accounts.ebda.app` (`__Host-ebda_sso`, `Secure; HttpOnly; SameSite=Lax`). It is NOT a `.ebda.app` domain cookie: every merchant storefront is `<slug>.ebda.app`, and a parent-domain cookie would be readable by and settable from tenant subdomains (cookie tossing). This is the binding constraint of the design.
- Product sign-in: product redirects to `/authorize`; if the central session exists the user returns immediately with a code (silent SSO); the product backend exchanges it for tokens. Products keep today's access/refresh pair shape (`tv`, `jti`, rotation), issued per product client with `aud` = that product, so a token for CRM cannot call Store APIs.
- Sign-out: front-channel logout to every client that holds a session + revoke the refresh families; `revokeAllSessions` (bump `tv`) remains the hard kill and becomes cross-product.
- MFA and step-up live only on `accounts.`; products request `acr` for sensitive actions (payouts, API keys).

## Service tokens (Whisky AI OS, Telegram bots, internal tools)

- OAuth client-credentials clients, one per tool, never a human's password or refresh token.
- Scoped (`orders:read`, `store:write`, `crm:contacts:read`, …), optionally pinned to one organization, short-lived (≤ 15 min) access tokens, client secret rotated, stored in each tool's secret store.
- Every call audited: `service_audit(client_id, organization_id, scope, method, path, status, ip, at)`, visible in a super-admin UI page (every data has a UI) and in the organization's own activity log when the call touched its data.
- RLS unchanged: a service token resolves to an organization/store scope and runs through the same `runInTenantContext`; there is still no bypass.

## Phasing

1. Organization + Membership tables, backfill one org per store (no UX change).
2. `accounts.ebda.app` login UI + issuer on the existing API (same user table, same MFA); `store.ebda.app` becomes its first client; `/login` on store. redirects to accounts.
3. WhatsApp and CRM launch as clients from day one.
4. Service-token clients + audit page; migrate the Telegram bots / OS off any stored human credentials.

## Open questions (Ahmad)

- Separate `accounts` Worker, or routes on `apps/api` behind `accounts.ebda.app`? (Lean: own small Worker for the UI, issuer endpoints in `apps/api` where the users already are.)
- Is a person allowed in several organizations on day one (agencies managing many merchants)? The model supports it; the UI needs an org switcher.
- Off-the-shelf issuer (e.g. a hosted IdP) vs our own: own keeps Arabic-first UX and RLS-integrated data; a hosted one costs per MAU. Decide before phase 2.
