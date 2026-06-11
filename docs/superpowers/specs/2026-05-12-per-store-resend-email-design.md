# Per-store branded email via Resend — design

**Date:** 2026-05-12
**Status:** approved (verbal, in-chat)
**Author:** Ahmad Sharaf + Claude
**Tracks:** [[reference-fwb-seo-system]] (sibling pattern for HTML-tag verification)

## Problem

Every transactional email currently ships from a single hardcoded `Force Media <noreply@forcemedia.com>` sender (note the typo in the env default — `forcemedia.com`, not `forcemediakw.com`). The HTML wrapper is hardcoded `Force Media` in both header bar and footer. Customers buying from Wady Aljuz get an order confirmation that looks like it came from a different company. There is no per-store branding, no per-merchant sender authentication, and no path for merchants to send under their own custom domain.

## Goals

1. Every transactional email reflects the store the customer bought from — display name, logo, theme color, contact details.
2. Merchants with a verified custom domain send under their own DKIM (`noreply@theirstore.com`); merchants without fall back to the platform domain (`noreply@forcemediakw.com`) with display-name branding.
3. The merchant never deals with Resend directly. The backend provisions Resend domains the same way the backend provisions Vercel domains for storefront routing — invisibly. The admin UI surfaces only the DNS records the merchant must add to their registrar, presented as one unified list.
4. Receipts include the full order content (items + totals + shipping address) and clearly identify the store.

## Non-goals

- Marketing/campaign email (Mailchimp-style broadcasts). This is transactional only.
- Per-merchant Resend account ownership. All merchant domains live under Force's single platform Resend account.
- Per-merchant SMTP credential entry. Resend SDK only.
- Migration of admin-facing alerts (admin new-order, admin refund, contact-form). They keep platform branding because the audience is the merchant, not the customer.

## Sender resolution

A single helper on the server resolves the `From` line per send, based on store state:

```ts
function resolveSender(store: StoreSenderShape): { from: string; replyTo?: string } {
  const displayName = store.name;
  const localPart = store.emailSenderLocalPart || 'noreply';
  if (store.emailDomainStatus === 'verified' && store.domain) {
    return {
      from: `${displayName} <${localPart}@${store.domain}>`,
      replyTo: store.email || undefined,
    };
  }
  return {
    from: `${displayName} <${localPart}@forcemediakw.com>`,
    replyTo: store.email || undefined,
  };
}
```

**Fallback to platform domain** kicks in when:

- Store has no custom domain
- Store has a custom domain but `emailDomainStatus !== 'verified'`
- Resend API errors during send (handled at the SDK call site — caller catches, retries via the existing Redis queue, never silently falls back)

`reply-to` is always set to `store.email` (the merchant's contact email) so customer replies route to the merchant.

The `emailSenderLocalPart` field defaults to `noreply` for every store at creation time. Merchants can override later (`hello`, `orders`, `support`, etc.) via the SEO/contact section of admin. Validate as `[a-z0-9._-]+` to keep it RFC-5321-compliant.

## Branded template wrapper

Replace `EmailService.baseTemplate(content)` with `baseTemplate(content, store)` which takes a store context:

```ts
interface EmailStoreContext {
  name: string;
  nameAr?: string | null;
  logo?: string | null;
  theme?: { primary?: string } | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  defaultLanguage?: 'en' | 'ar';
}
```

Changes vs current static wrapper:

- **Header bar** background = sanitized `store.theme.primary` (HSL string or hex, runs through the existing `sanitizeThemeColor` pipeline from `apps/web/src/app/layout.tsx`). Fall back to platform orange `#ff6e00` if missing or invalid.
- **Header content** = `<img src="${store.logo}">` if logo present, else `<h1>${store.name}</h1>` in white. RTL-aware via `dir="rtl"` when `defaultLanguage === 'ar'`.
- **Footer** = `© ${year} ${store.name}` + store address + phone + contact email, followed by a small grey "Powered by Force AI" attribution line.
- **Subjects** — every hardcoded "Force Media" in `subject:` strings replaced with `store.name`. Localized AR variants when `defaultLanguage === 'ar'`.
- **Order confirmation** receipt content — already structurally correct (items + totals + shipping addr). Add the "Thanks for shopping at ${store.name}" line at the top.

All store-supplied strings continue to flow through `escapeHtml()` to preserve the XSS hardening already in place.

## Resend SDK integration

Add `resend` (npm package) to `apps/api` dependencies. Drop `nodemailer` once all call sites migrate (the existing email queue stays — it just queues calls into Resend SDK instead of nodemailer transport).

Single env var `RESEND_API_KEY` on Railway. All merchant domains live under one Resend account.

New `apps/api/src/services/resend.service.ts`:

```ts
class ResendService {
  // Wraps `resend.emails.send` with sender resolution and template wrapping.
  static async sendBrandedEmail(
    storeId: string,
    opts: {
      to: string | string[];
      subject: string;
      html: string; // pre-rendered template content
      text?: string;
    }
  ): Promise<void>;

  // Calls resend.domains.create({ name: store.domain }), stores the returned
  // domain UUID + DKIM records on Store. Idempotent if a record already exists.
  static async provisionStoreDomain(storeId: string): Promise<DomainDnsRecord[]>;

  // Calls resend.domains.get(domainId), updates `emailDomainStatus`. Returns
  // status + raw DNS record list (so admin can re-render the unified list).
  static async refreshDomainStatus(storeId: string): Promise<DomainStatusUpdate>;

  // Symmetric to Vercel removeDomain. Called when merchant changes/removes
  // their custom domain — wired into the existing compensating-rollback in
  // provisioning.service.ts and store.routes.ts PUT /stores/:id/domain.
  static async removeStoreDomain(storeId: string): Promise<void>;
}
```

`EmailService` (the existing facade) keeps its public methods (`sendOrderConfirmation`, `sendPaymentSuccess`, etc.) — each one now loads the store record, builds the branded HTML, and delegates the send to `ResendService.sendBrandedEmail`. The Inngest `invoice-email` function passes through the same way; it already has `storeId` in the event payload.

## Schema changes

Three new nullable columns on `Store`, plus one defaulting field:

```prisma
model Store {
  // ... existing fields
  emailSenderLocalPart    String   @default("noreply") @map("email_sender_local_part")
  emailDomainId           String?  @map("email_domain_id")           // Resend domain UUID
  emailDomainStatus       String?  @map("email_domain_status")       // pending | verified | failed
  emailDomainVerifiedAt   DateTime? @map("email_domain_verified_at")
}
```

`emailDomainStatus` mirrors Resend's domain status enum. We store the string verbatim so we don't need to keep the mapping in sync if Resend adds states.

One Prisma migration, no data backfill required — every existing store starts with `emailDomainId = null` and `emailDomainStatus = null`, which the sender resolver maps to "use platform fallback". The `emailSenderLocalPart` default `'noreply'` populates retroactively via the Prisma `@default` on column add.

## Admin UI — unified DNS records list

The merchant should never see "Vercel" or "Resend" as provider names — the backend handles both invisibly. Same pattern as the existing custom-domain flow (today the merchant adds a custom domain via `/stores/[id]/domain`, we silently call `VercelDomainService.addDomain` and surface only the A/CNAME they need to add at their registrar).

Bundled into `/stores/[id]/domain`:

1. **"Custom domain" card** — unchanged.
2. **"Email sender" card** (new) — appears when a custom domain is set.
   - Status: `Sending as: Wady Aljuz <noreply@wadyaljuz.com>` + badge (`verified` / `pending` / `not configured` / `failed`).
   - When status is `pending` or `not configured`, button "Set up branded email" calls `POST /api/v1/stores/:id/email-sender/provision` which runs `ResendService.provisionStoreDomain` and returns DNS records.
   - When status is `pending`, "Verify" button calls `POST /api/v1/stores/:id/email-sender/verify` which runs `ResendService.refreshDomainStatus`. Polling cadence: on button click only (no background polling).
3. **"DNS records" panel** (new, unified) — single list showing every DNS record the merchant needs to add at their registrar. Each row: `Type | Host | Value` + a copy button. Internally we merge Vercel's records (A/CNAME for storefront routing) with Resend's records (3 DKIM CNAMEs + 1 SPF TXT). The merchant sees one list. No mention of underlying providers.

The local-part config (`hello@`, `orders@`, etc.) lives on the existing `/stores/[id]/seo` page next to the contact email — small input field "Sender prefix" with validation. Default `noreply`.

## API routes

New endpoints under `apps/api/src/routes/store.routes.ts` (existing chain: `authenticate → authorize('store_admin', 'super_admin') → requireStoreAccess`):

```
POST /stores/:id/email-sender/provision   → ResendService.provisionStoreDomain
POST /stores/:id/email-sender/verify      → ResendService.refreshDomainStatus
GET  /stores/:id/email-sender/dns         → returns unified DNS record list (Vercel + Resend merged)
```

`GET /stores/:id/domain` (existing) is extended to include `dnsRecords` in its response shape so the admin page can render the unified panel from one fetch.

## Failure & rollback semantics

- **Resend domain provision fails** during merchant's "Add domain" flow → the merchant's storefront custom domain still works (Vercel side committed first). Email branding stays on platform fallback. Failure logged, exposed in status card, retry button available. Does NOT block storefront usage.
- **Resend domain provisioned but DNS not yet added** → status stays `pending`, sender falls back to platform domain. No customer-visible bounce.
- **Send fails after retries** → existing `email:failed` Redis queue captures it. No change to that path.
- **Merchant removes/changes custom domain** → the existing PUT `/stores/:id/domain` compensating-rollback in `provisioning.service.ts` is extended with `ResendService.removeStoreDomain` in the same transaction. Order: add new Vercel domain → add new Resend domain → DB update → remove old Resend domain → remove old Vercel domain. Old Vercel removal stays fire-and-forget after the new one is live (preserves the storefront-uptime guarantee documented in project memory).

## Bug-class audit (per Ahmad's standing rule)

While in this code path, fix all instances of the `forcemedia.com` typo. Grep `apps/api/src` + `packages/shared/src` for `'forcemedia.com'` (without the `kw`) and replace with `'forcemediakw.com'`. Also audit subject-line and template-string hardcodes for any other `Force Media` / `Force AI Store` references that should be `store.name` in the customer-facing path.

## Out of scope (deferred)

- Bounced-email handling and reputation monitoring. Resend exposes webhooks; wire later.
- Per-store email open / click tracking. Resend supports it; add when there's a merchant ask.
- Localized full Arabic templates (the AR variant currently only affects the wrapper and subject lines; full content translation belongs to the i18n broader work).
- Marketing/broadcast email. Stays out of scope; this is transactional only.

## Implementation order (sketch)

The detailed plan goes in a separate file via the `writing-plans` skill, but the rough ordering is:

1. Schema migration (Prisma).
2. `ResendService` (provision/verify/remove + sendBrandedEmail).
3. Refactor `EmailService.baseTemplate` to take store context; thread `storeId` through every `EmailService.send*` call site.
4. API routes for provision/verify/dns.
5. Admin domain page: email-sender card + unified DNS list.
6. Admin SEO page: sender prefix input.
7. Fix the `forcemedia.com` typo + bug-class audit.
8. Smoke test against a real merchant store (Wady Aljuz) using a test order.
