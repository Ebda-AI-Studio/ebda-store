import { Router } from 'express';
import authRoutes from './auth.routes';
import merchantSignupRoutes from './merchant-signup.routes';
import onboardingRoutes from './onboarding.routes';
import setupGuideRoutes from './setup-guide.routes';
import attentionRoutes from './attention.routes';
import mfaRoutes from './mfa.routes';
import passkeyRoutes from './passkey.routes';
import {
  meLegalNoticeRoutes,
  meLegalAcceptanceRoutes,
  adminLegalPolicyRoutes,
} from './legal-policy.routes';
import storeRoutes from './store.routes';
import blogRoutes from './blog.routes';
import locationsRoutes from './locations.routes';
import productRoutes from './product.routes';
import cartRoutes from './cart.routes';
import orderRoutes from './order.routes';
import customersRoutes from './customers.routes';
import reviewRoutes from './review.routes';
import analyticsRoutes from './analytics.routes';
import answerEngineRoutes from './answer-engine.routes';
import productFeedsRoutes from './product-feeds.routes';
import returnRoutes from './return.routes';
import publicRoutes from './public.routes';
import paymentRoutes from './payment.routes';
import paymentSettingsRoutes from './payment-settings.routes';
import uploadRoutes from './upload.routes';
import adminRoutes from './admin.routes';
import adminAnswerEngineRoutes from './admin-answer-engine.routes';
import platformTaxRoutes from './platform-tax.routes';
import providerActivationRoutes, {
  adminProviderActivationRoutes,
} from './provider-activation.routes';
import couponRoutes from './coupon.routes';
import shippingRoutes from './shipping.routes';
import taxRoutes from './tax.routes';
import etaRoutes from './eta.routes';
import { fiscalArchiveRoutes, fiscalDocumentRoutes } from './fiscal-document.routes';
import { adminDoColoRoutes } from './admin-do-colo.routes';
import customerGroupRoutes from './customer-groups.routes';
import priceTierRoutes from './price-tier.routes';
import { publicWholesaleRouter, merchantWholesaleRouter } from './wholesale.routes';
import promotionRoutes from './promotion.routes';
import bundleRoutes from './bundle.routes';
import loyaltyRoutes, { publicLoyaltyRoutes } from './loyalty.routes';
import walletRoutes from './wallet.routes';
import pwaRoutes from './pwa.routes';
import qrRoutes from './qr.routes';
import ciRoutes from './ci.routes';
import adminCiRoutes from './admin-ci.routes';
import adminTrustRequestsRoutes from './admin-trust-requests.routes';
import barcodeLabelRoutes from './barcode-labels.routes';
import inventoryRoutes from './inventory.routes';
import bulkRoutes from './bulk.routes';
import catalogImportRoutes from './catalog-import.routes';
import supportRoutes from './support.routes';
import variantRoutes from './variant.routes';
import productModelRoutes from './product-model.routes';
import categoryRoutes from './category.routes';
import tagRoutes from './tag.routes';
import sizeChartRoutes from './size-chart.routes';
import goldRateRoutes from './gold-rate.routes';
import aiRoutes from './ai.routes';
import { assistantAdminRoutes, assistantRoutes } from './assistant.routes';
import wishlistRoutes from './wishlist.routes';
import addressRoutes from './address.routes';
import featureRoutes from './feature.routes';
import notificationRoutes, { publicNotificationRoutes } from './notification.routes';
import abandonedCartRoutes from './abandoned-cart.routes';
import recommendationRoutes, { publicRecommendationRoutes } from './recommendation.routes';
import shippingCarrierRoutes from './shipping-carrier.routes';
import affiliateRoutes, { publicAffiliateRoutes } from './affiliate.routes';
import newsletterRoutes from './newsletter.routes';
import campaignRoutes, { campaignTestSendRouter, campaignAiDraftRouter } from './campaign.routes';
import campaignPublicRoutes from './campaign-public.routes';
import merchantWebhookRoutes from './merchant-webhooks.routes';
import {
  accountRouter as smsConsentAccountRoutes,
  publicRouter as smsConsentPublicRoutes,
} from './sms-consent.routes';
import onesignalRoutes from './onesignal.routes';
import storeLayoutRoutes from './store-layout.routes';
import pageBuilderRoutes from './page-builder.routes';
import publicStoreLayoutRoutes from './public-store-layout.routes';
import pagesRoutes from './pages.routes';
import typographyRoutes from './typography.routes';
import agentCredentialRoutes from './agent-credential.routes';
import merchantKeyRoutes from './merchant-key.routes';
import financeRoutes from './finance.routes';
import smartLayerRoutes from './smart-layer.routes';
import insightsRoutes from './insights.routes';
import searchInsightsRoutes from './search-insights.routes';
import adminSearchRoutes from './admin-search.routes';
import suppliersRoutes from './suppliers.routes';
import reorderRulesRoutes from './reorder-rules.routes';
import purchaseOrdersRoutes from './purchase-orders.routes';
import packingSlipRoutes from './packing-slip.routes';
import stockAdjustmentsRoutes from './stock-adjustments.routes';
import warehouseRoutes from './warehouse.routes';
import expensesRoutes from './expenses.routes';
import backordersRoutes from './backorders.routes';
import slugRedirectsRoutes from './slug-redirects.routes';
import staffRoutes from './staff.routes';
import storeActivityRoutes from './store-activity.routes';
import staffInviteRoutes from './staff-invite.routes';
import billingRoutes from './billing.routes';
import paymentAbandonmentsRoutes from './payment-abandonments.routes';
import lifecycleEmailsRoutes from './lifecycle-emails.routes';
import whatsappLinkRoutes from './whatsapp-link.routes';
import lifecycleEmailsPublicRoutes from './lifecycle-emails-public.routes';
import contactEnquiryPublicRoutes from './contact-enquiry-public.routes';
import orderStatusPublicRoutes from './order-status-public.routes';
import mcpRoutes from './mcp.routes';
import mcpAdminRoutes from './mcp-admin.routes';
import realtimeRoutes from './realtime.routes';
import {
  tenantContext,
  aiRouteContext,
  orderRouteContext,
  publicStoreContext,
  billingRouteContext,
} from '../middleware/tenant-context';

import storeDoSpikeRoutes from './store-do-spike.routes';
import demoHomeRoutes from './demo-home.routes';
const router = Router();

// Public routes (no auth required)
// Every /public request that names a store (X-Store-ID / x-store-domain / a UUID
// path segment) runs in that store's RLS scope: one request transaction for
// reads, per-query short transactions for writes. See publicStoreContext.
router.use('/public', publicStoreContext);
router.use('/public', publicRoutes);
router.use('/public', publicWholesaleRouter);
router.use('/public', publicStoreLayoutRoutes);

// Token + store-room authority for the Workers realtime Durable Object (no tenant scope:
// it reads only the `stores` routing table).
router.use('/realtime', realtimeRoutes);
// Phase 0 StoreDO spike loader: 404 unless the flag AND the seed secret are set (routes/store-do-spike.routes.ts).
router.use('/internal/store-do', storeDoSpikeRoutes);
// Demo-store home seed on the StoreDO (Ruling DEMO-SEED-DO-1): 404 unless DEMO_SEED_TOKEN is set; demo stores only.
router.use('/internal/demo-home', demoHomeRoutes);

// Store-scoped MCP endpoint (agent checkout) — POST /api/v1/mcp/:storeSlug.
// Resolves the store by slug + checks the `agent_checkout` feature gate
// itself (see mcp.routes.ts); no auth middleware or tenantContext here —
// it is a public, feature-gated, per-slug surface for MCP clients.
// MERCHANT-ADMIN MCP endpoint — POST /api/v1/mcp/admin/:storeSlug.
// MUST be mounted BEFORE '/mcp', or `mcpRoutes`'s `/:storeSlug` would match
// the literal segment "admin" and route every merchant request into the
// anonymous BUYER server — which would 404 on an unknown slug and look like
// a config problem rather than the security hole it is. Express matches in
// registration order; this line's position is load-bearing.
router.use('/mcp/admin', mcpAdminRoutes);
router.use('/mcp', mcpRoutes);
// SMS-marketing consent (issue 206): the shopper's own opt-in on the account
// page. Mounted before '/auth' so the auth router never sees the path. The
// `/auth/` prefix does NOT exempt its PUT from CSRF: only the credential-less
// auth entry points are exempt (`isCsrfExemptAuthPath`, issue 2425).
router.use('/auth/me/sms-consent', smsConsentAccountRoutes);
router.use('/auth/merchant', merchantSignupRoutes);
router.use('/auth', authRoutes);
router.use('/staff-invites', staffInviteRoutes);
// MFA sub-routes: enroll/begin, enroll/verify, verify (challenge), disable.
// Mounted under /auth/mfa so the full path is /api/v1/auth/mfa/*.
// Must come AFTER auth routes and BEFORE any catch-all.
router.use('/auth/mfa', mfaRoutes);
router.use('/auth/passkeys', passkeyRoutes);
// Legal policy notices for the signed-in merchant (Ruling LEGAL-4): user-level, no store scope.
router.use('/me/legal-notices', meLegalNoticeRoutes);
router.use('/me/legal-acceptances', meLegalAcceptanceRoutes);

// Payment routes
router.use('/payments', paymentRoutes);

// Payment settings (super admin)
router.use('/payment-settings', paymentSettingsRoutes);

// Merchant: ask Ebda to activate a provider that is not verified yet (PROVIDERS-ACTIVATION)
router.use('/provider-activation', providerActivationRoutes);

// Upload routes
router.use('/uploads', uploadRoutes);

// Answer-engine provider config (super_admin) — encrypted Perplexity/OpenAI
// API keys + enabled toggles. AnswerEngineProviderConfig is a platform table
// with no store_id, so tenantContext here is a no-op (same as adminRoutes
// below) — kept only for mount-shape consistency with the other /admin routers.
//
// MUST be mounted BEFORE adminRoutes: admin.routes.ts applies an
// unconditional `router.use(requireMfaEnrolled)` that gates EVERY request
// under '/admin' (super_admin without MFA enrolled → 403), including paths
// that don't match any of its own routes — `next(err)` from that guard
// short-circuits straight to the app's error handler and never falls
// through to a router mounted after it. Mounting this router first is purely
// for REACHABILITY past that catch-all gate — the answer-engine router now
// carries its own `authenticate → requireMfaEnrolled → requireRole(['super_admin'])`
// chain per route (matching feature.routes.ts / insights.routes.ts), so MFA
// enforcement is self-contained here regardless of mount order.
router.use('/admin', tenantContext, adminAnswerEngineRoutes);

// Super-admin VAT review queue + Ebda's own VAT setting (ruling TAX-2/TAX-6).
// Mounted BEFORE adminRoutes for reachability past its catch-all MFA gate; it
// carries its own authenticate → requireMfaEnrolled → authorize('super_admin').
router.use('/admin', platformTaxRoutes);
router.use('/admin', fiscalArchiveRoutes);
// Super-admin placement echo (Ruling PERF-AUTHSTATE-1, off unless DO_COLO_ECHO=on): own auth chain, BEFORE adminRoutes' catch-all gate.
router.use('/admin', adminDoColoRoutes);

// Super-admin policy updates (Ruling LEGAL-4). BEFORE adminRoutes' catch-all MFA gate; it
// carries its own authenticate -> MFA -> super_admin chain.
router.use('/admin', adminLegalPolicyRoutes);

// Customer Intelligence insights + hint kill switches (CI-2/CI-3, Rulings CI-9/CI-10). Same reachability
// rule: before adminRoutes' catch-all MFA gate; it carries its own authenticate -> MFA -> super_admin chain.
router.use('/admin', adminCiRoutes);
router.use('/admin', adminTrustRequestsRoutes);

// Provider activation queue (PROVIDERS-ACTIVATION). Same reachability rule as the tax routes: before
// adminRoutes' catch-all MFA gate; it carries its own authenticate → MFA → super_admin chain.
router.use('/admin', adminProviderActivationRoutes);

// Admin routes (super_admin only).
//
// AUDITED (2026-07-02, F2 follow-up) and INTENTIONALLY LEFT UNFIXED here:
// `tenantContext` at this bare '/admin' mount is a no-op (same root cause as
// the couponRoutes block below), but admin.routes.ts reuses the SAME ':id'
// token for THREE different entity types across its own routes —
// '/stores/:id' (a store id), '/users/:id' (a user id), '/products/:id' (a
// product id) — all legitimately cross-tenant super_admin surfaces (list
// all stores/users/products/orders/customers, dashboard, audit-logs).
// Registering `router.param('id', tenantContext)` inside admin.routes.ts
// like the other fixed routers would be WRONG: it would try to open a
// single-store RLS transaction using a user id or product id as the
// "storeId" for the non-store routes, which would either no-op (falls the
// UUID check) or — worse, post-ebda_app-cutover — silently scope every
// query in that request to zero rows (current_store_id() would never match
// any real store_id). Left unchanged; see the PR description for this ticket.
router.use('/admin', tenantContext, adminRoutes);

// OneSignal admin push subscription endpoints (any authenticated user can
// subscribe their own device; tags + REST filters scope which devices receive
// each notification — see services/onesignal.service.ts).
router.use('/admin', onesignalRoutes);

// Feature management routes (super_admin: /admin/stores/:id/features, store_admin: /stores/:storeId/my-features).
//
// REWORKED 2026-07-02 (F2 surgical follow-up, PR #499): a
// `router.param('id' | 'storeId', tenantContext)` registration was briefly
// added here (Phase 1a), then REVERTED — `featureService.getStoreFeatures`
// → `readFromDb` calls `withRlsBypass` internally (shared with background
// Inngest fan-out that has no tenant GUC), and `withRlsBypass` opens its
// own `basePrisma.$transaction`. Nesting that inside the outer per-request
// tenant tx would hold 2 DB connections per request. This router is
// CONTEXT-LESS (bare '/admin' + '/stores' mounts, no per-route param
// registration) — Phase 2 candidate; needs `readFromDb`'s request-handler
// call path rewired to the ALS-aware `prisma` proxy before it's safe to wrap.
router.use('/admin', tenantContext, featureRoutes);
router.use('/stores', tenantContext, featureRoutes);

// Store routes.
//
// REWORKED 2026-07-02 (F2 surgical follow-up, PR #499): a
// `router.param('id', tenantContext)` registration was briefly added here
// (Phase 1a), then REVERTED — the domain-management handlers in
// store.routes.ts call external APIs in-request (Cloudflare-for-SaaS domain
// provisioning via `resolveDomainService`, Resend domain verification via
// `StoreMailer.provisionStoreDomain` / `removeStoreDomain` /
// `verifyAndRefreshDomain`). Trapping a slow third-party call inside a 30s
// RLS interactive transaction risks blowing the timeout. This router is
// CONTEXT-LESS — Phase 2 candidate; the CRUD-only handlers are fine, only
// the domain endpoints need per-route (not per-router) context wiring.
router.use('/stores', tenantContext, storeRoutes);

// D2 campaign routes that make a SLOW EXTERNAL CALL (Resend test send #1954,
// Gemini ai-draft EBDA-API-2G) and therefore must run with NO request
// transaction open.
//
// THEIR POSITION HERE IS LOAD-BEARING — they MUST stay above
// `router.use('/stores/:storeId', tenantContext, customersRoutes)` below.
// An Express `use` mount is a PREFIX match, so that mount matches every
// `/stores/<uuid>/*` request including these two: `tenantContext` would open
// the per-request interactive transaction, customersRoutes would match none of
// its own `/customers/*` routes, and the request would fall through to these
// mounts STILL INSIDE that transaction (the #1602 fall-through documented in
// middleware/tenant-context.ts). `storeScopeContext` cannot undo it — the
// prisma proxy checks `tenantStorage` BEFORE `storeScope`
// (`const scope = tx ? undefined : storeScope.getStore()`, packages/database/
// src/index.ts), so every query would route back onto the open tx and the
// 30s-timeout failure these mounts exist to prevent would happen anyway.
// Pinned by tests/unit/ai-routes-no-request-transaction.test.ts.
router.use('/stores/:storeId/campaigns', campaignTestSendRouter);
router.use('/stores/:storeId/campaigns', campaignAiDraftRouter);

// Product 3D models. MUST stay above the `/stores/:storeId/products` and
// `/stores/:storeId` tenantContext mounts below, for the same prefix-match
// reason as the campaign routers above: its two uploads must run with NO
// request transaction open (a 15 MB upload can outlive the 30 s transaction);
// each route that is DB-only adds `tenantContext` itself. Pinned by
// tests/unit/product-model-routes-mount.test.ts.
router.use('/stores/:storeId/product-models', productModelRoutes);

// Store-scoped routes — tenantContext wraps all downstream handlers in an RLS transaction
router.use('/admin/stores/:storeId/layout', tenantContext, storeLayoutRoutes);
// Visual builder page documents (draft / publish / revisions / rollback).
router.use('/admin/stores/:storeId/builder', tenantContext, pageBuilderRoutes);
router.use('/stores/:storeId/products', tenantContext, productRoutes);
router.use('/stores/:storeId/categories', tenantContext, categoryRoutes);
router.use('/stores/:storeId/tags', tenantContext, tagRoutes);
router.use('/stores/:storeId/size-charts', tenantContext, sizeChartRoutes);
router.use('/stores/:storeId/gold-rates', tenantContext, goldRateRoutes);
// Context chosen PER REQUEST, not per router (EBDA-API-2G): the WRITES here
// await Gemini and the request transaction expires 30s after BEGIN — a slow
// model call made the COMMIT fail on a request whose work was already done, so
// they run under store scope (one short transaction per query). The GETs
// (`/usage/*`, `/results/*`, `/bulk*`) touch no third party and stay on
// `tenantContext`: under store scope each query in their `Promise.all` fan-outs
// would take its own pooled connection, and the admin AI-tools page fires 9 of
// the `/results/*` endpoints at once — enough to exhaust `connection_limit=15`
// and make unrelated requests on the pod fail P2024. See `aiRouteContext`.
router.use('/stores/:storeId/ai', aiRouteContext, aiRoutes);
// The Ebda assistant: same reason as /ai (a model call must not sit inside a request transaction). Above the bare `/stores/:storeId` mounts below.
router.use('/stores/:storeId/assistant', aiRouteContext, assistantRoutes);
router.use('/admin/assistant', assistantAdminRoutes);
router.use('/stores/:storeId/typography', tenantContext, typographyRoutes);
router.use('/stores/:storeId/cart', tenantContext, cartRoutes);
// Context per request (SP6b): the admin payment link calls a payment gateway, so it runs
// under store scope (no long transaction held across the call); every other order route
// keeps its one request transaction. See `orderRouteContext`.
router.use('/stores/:storeId/orders', orderRouteContext, packingSlipRoutes);
router.use('/stores/:storeId/orders', orderRouteContext, orderRoutes);
// Customers export (.xlsx). Mounted at /stores/:storeId so the route
// has access to storeId via mergeParams.
router.use('/stores/:storeId', tenantContext, customersRoutes);
router.use('/stores/:storeId/reviews', tenantContext, reviewRoutes);
router.use('/stores/:storeId/analytics', tenantContext, analyticsRoutes);
router.use('/stores/:storeId/answer-engine', tenantContext, answerEngineRoutes);
router.use('/stores/:storeId/product-feeds', tenantContext, productFeedsRoutes);
router.use('/stores/:storeId/returns', tenantContext, returnRoutes);

// Store-scoped routes mounted under /stores (storeId in sub-route params).
//
// NOTE (fixed 2026-07-02, audit F2): `tenantContext` passed to `router.use`
// at these BARE '/stores' mounts is a no-op — Express only populates
// req.params for params declared in the MOUNT path, and these mounts have
// none. For couponRoutes / shippingRoutes / taxRoutes / loyaltyRoutes /
// pwaRoutes / bulkRoutes / variantRoutes, RLS tenant context IS set via
// `router.param('storeId', tenantContext)` registered INSIDE each
// sub-router file, which fires after Express resolves the param for the
// matched route — verified fast, DB-only, no inner context/tx. The
// `tenantContext` argument here is kept only for readability/consistency
// with the correctly-wired `/stores/:storeId/...` mounts above. See
// docs/plans/done/2026-07-02-rls-cutover.md (Phase 1a) and
// docs/audits/2026-07-02-tenancy-rls-auth.md (F2).
//
// inventoryRoutes is the exception: REWORKED 2026-07-02 (surgical
// follow-up, PR #499) — its `router.param('storeId', tenantContext)` was
// REVERTED because `reconcileCountSession` (services/barcode-scan.service.ts)
// calls `runInTenantContext` internally for the cycle-count reconcile path,
// which would double-nest a second `basePrisma.$transaction` inside the
// outer per-request tx. inventoryRoutes stays CONTEXT-LESS — Phase 2
// candidate. (The accounting create* services it and the stock-adjustment /
// PO / expense routes reach no longer add a nested tx of their own: their
// ownership guard reuses an ambient context via
// assertStoreOwnsInTenantScope — issue 2057. reconcileCountSession's own
// runInTenantContext is what still blocks this router.)
router.use('/onboarding', onboardingRoutes);
router.use('/stores', tenantContext, setupGuideRoutes);
router.use('/stores', tenantContext, attentionRoutes);
router.use('/stores', tenantContext, couponRoutes);
router.use('/stores', tenantContext, shippingRoutes);
router.use('/stores', tenantContext, taxRoutes);
// Egypt ETA e-receipt connector (Ruling ETA-1); every route behind the per-store `eta_ereceipt` feature.
router.use('/stores', tenantContext, etaRoutes);
router.use('/stores', tenantContext, fiscalDocumentRoutes);
router.use('/stores', tenantContext, customerGroupRoutes);
router.use('/stores', tenantContext, priceTierRoutes);
router.use('/stores', tenantContext, merchantWholesaleRouter);
router.use('/stores', tenantContext, promotionRoutes);
router.use('/stores', tenantContext, bundleRoutes);
// Customer wallet (store credit) — every route behind requireFeature('customer_wallet').
router.use('/stores', tenantContext, walletRoutes);
router.use('/stores', tenantContext, pwaRoutes);
router.use('/stores', tenantContext, qrRoutes);
// Customer Intelligence hints + settings (CI-3, Ruling CI-10): advise only, never in a write path.
router.use('/stores', tenantContext, ciRoutes);
router.use('/stores', tenantContext, barcodeLabelRoutes);
router.use('/stores', tenantContext, inventoryRoutes);
router.use('/stores', tenantContext, bulkRoutes);
router.use('/stores', tenantContext, catalogImportRoutes);
// Merchant to Ebda staff: support request, suspension reason + appeal (SELF-SERVICE A13/A14)
router.use('/stores', tenantContext, supportRoutes);
router.use('/stores', tenantContext, variantRoutes);

// Loyalty routes. Pulled out of the bare-'/stores'-only block above (fixed
// 2026-09-25): the customer-facing endpoints declare their own
// '/:storeId/loyalty/...' paths, so they need the '/public' mount — a single
// '/stores' mount left the storefront calling '/public/:storeId/loyalty/join'
// etc. against a router that never listened there, 404ing on every live
// store. See F2, docs/plans/done/2026-07-02-rls-cutover.md for the RLS wiring.
//
// TWO SEPARATE ROUTERS, and the split is load-bearing: `publicLoyaltyRoutes`
// carries ONLY join/my-points/my-transactions/info. Mounting the whole
// loyalty router at '/public' (as affiliate/notification/abandoned-cart/
// recommendation/shipping-carrier all did until #1993 split them the same way)
// would republish the ADMIN half at '/public/:storeId/loyalty/...', where
// BOTH of the path-prefix-keyed global controls in middleware/security.ts
// stop applying: `csrfProtection` skips anything containing '/public/', and
// `restrictPlatformOnlyOrigins` only denies '/api/v1/stores'. Since CORS
// allowlists every merchant-registered custom domain with credentials:true,
// that combination hands a merchant-controlled page credentialed
// cross-origin reads of another store's loyalty members + transactions
// (names, emails, order numbers) and CSRF-free point-award writes whenever a
// store_admin/super_admin can be lured to it. See the header comment in
// loyalty.routes.ts; guarded by tests/unit/storefront-loyalty-route-contract.test.ts.
router.use('/stores', tenantContext, loyaltyRoutes);
router.use('/public', publicLoyaltyRoutes);

// Pages CMS — admin CRUD under /stores/:storeId/pages and public read
// under /public/:storeId/pages/:slug. The shared router internally
// declares both surfaces; mounting at the API root preserves the full
// path prefixes (`/stores/...` + `/public/...`).
//
// NOTE (fixed 2026-07-02, F2): pages/blog/locations all declare an
// explicit ':storeId' param in their OWN routes (not a slug/host lookup),
// so they have the exact same bare-mount bug as the couponRoutes block
// below. `tenantContext` here at the bare '/' mount is a no-op; RLS
// context is set via `router.param('storeId', tenantContext)` registered
// inside each of pages.routes.ts / blog.routes.ts / locations.routes.ts.
router.use('/', tenantContext, pagesRoutes);

// Blog (Bucket E1, 2026-05-17) — same dual-surface pattern as pages.
// Admin CRUD under /stores/:storeId/blog, public reads under
// /public/:storeId/blog. Both 404 when the store hasn't opted in.
router.use('/', tenantContext, blogRoutes);

// Locations / Branches (2026-06-16) — same dual-surface pattern.
// Admin CRUD under /stores/:storeId/locations, public reads under
// /public/:storeId/locations. Both 404 when locationsEnabled=false.
router.use('/', tenantContext, locationsRoutes);

// Notification routes (admin + public push).
// CONTEXT-LESS (Phase 2 candidate, reverted 2026-07-02 PR #499):
// notificationConfigService.readFromDb calls withRlsBypass internally
// (double-nesting risk) AND testConnection calls an external SMS provider
// API in-request — both disqualify the whole-request tx wrap.
router.use('/stores', tenantContext, notificationRoutes);
router.use('/public', publicNotificationRoutes);

// NO admin router is ever mounted at '/public' (#1993) — the five routers
// here used to be, which republished their admin routes (incl. the affiliate
// payout money-write) under a prefix csrfProtection skips. The storefront
// halves live on separate `public*Routes` routers; abandoned-cart and
// shipping-carrier have no '/public/:storeId' storefront routes at all (their
// public endpoints are '/stores/public/...'). Enforced for EVERY mount by
// tests/unit/public-mount-admin-route-guard.test.ts.

// Abandoned cart routes (admin + public recovery at /stores/public/...)
router.use('/stores', tenantContext, abandonedCartRoutes);

// Recommendation routes (admin + public).
// CONTEXT-LESS (Phase 2 candidate, reverted 2026-07-02 PR #499):
// the admin recalculate endpoint fires `recommendationService.recalculateFBT`
// fire-and-forget (no await) so the response can return before it finishes —
// wrapping the request would let the outer tx commit while the detached
// work is still running, then hit "transaction already closed".
router.use('/stores', tenantContext, recommendationRoutes);
router.use('/public', publicRecommendationRoutes);

// Shipping carrier routes (admin + public tracking at /stores/public/...).
// Scoped PER REQUEST inside the router (`router.param('storeId', shippingCarrierRouteContext)`):
// reads share one request transaction, while booking / cancelling / tracking / label calls to the
// courier APIs run under store scope so no transaction is held across a slow third party.
router.use('/stores', shippingCarrierRoutes);

// Affiliate routes (admin + public apply/track)
router.use('/stores', tenantContext, affiliateRoutes);
router.use('/public', publicAffiliateRoutes);

// Newsletter admin routes (list + CSV export). Public signup is in
// public.routes.ts so visitors don't need a JWT to subscribe.
// CONTEXT-LESS (Phase 2 candidate, reverted 2026-07-02 PR #499): the
// broadcast endpoint loops `StoreMailer.sendBrandedEmail` in chunks of 50,
// sequentially awaited in-request — a large subscriber list can run well
// past 30s, which would blow the RLS transaction's timeout.
router.use('/stores', tenantContext, newsletterRoutes);
// D2 email campaigns. Admin router under a `:storeId` mount so tenantContext
// really sets the RLS GUCs (unlike the bare '/stores' mounts above); every
// route inside also requires the `email_campaigns` feature. The public router
// is the login-free unsubscribe endpoint (store comes from the signed token).
// The two campaign routers that await a third party (test send #1954, ai-draft
// EBDA-API-2G) are mounted WITHOUT tenantContext, far above this line and
// above the prefix-capturing '/stores/:storeId' mount — see the comment there
// for why that position is load-bearing. They carry the full auth + feature
// chain on the route; every other path falls through to this mount.
router.use('/stores/:storeId/campaigns', tenantContext, campaignRoutes);
router.use('/public/campaigns', campaignPublicRoutes);
// Merchant outgoing webhooks (owner-only, Growth + Business). DNS check on create is the only slow call.
router.use('/stores/:storeId/webhooks', tenantContext, merchantWebhookRoutes);
// Login-free opt-out link carried by every promotional SMS (issue 206).
router.use('/public/sms-consent', smsConsentPublicRoutes);

// Agent (MCP) write-credential admin — mint / rotate / revoke the per-store
// `x-agent-key`. Per-store credential admin (`/stores/:id/integrations/...`).
// `tenantContext` here is the same bare-mount no-op it is on every `/stores`
// line above (Express only fills params declared in the MOUNT path); tenant
// scoping comes from `requireStoreAccess` inside the router.
router.use('/stores', tenantContext, agentCredentialRoutes);
router.use('/stores', tenantContext, merchantKeyRoutes);

// Finance routes (COA tree + general ledger journal).
// CONTEXT-LESS (Phase 2 candidate, reverted 2026-07-02 PR #499): the
// accounting services already call `runInTenantContext`/`withRlsBypass`
// per-query internally — wrapping the whole request would double-nest.
router.use('/stores', tenantContext, financeRoutes);

// Smart layer routes (reorder suggestions + deadstock flags + profit anomalies).
// CONTEXT-LESS (Phase 2 candidate, reverted 2026-07-02 PR #499): same
// reason as financeRoutes — services already self-manage tenant context
// per-query.
router.use('/stores', tenantContext, smartLayerRoutes);

// Reorder rules CRUD (M-107): merchant thresholds the reorder scan reads. Store-scoped, no money effect.
router.use('/stores', tenantContext, reorderRulesRoutes);

// Insights routes (cohort + funnel + rfm + dashboard — Batch 4).
// CONTEXT-LESS (Phase 2 candidate, reverted 2026-07-02 PR #499):
// `generateInsightNarration` calls Gemini in-request — an external AI call
// has no place inside a 30s RLS transaction.
router.use('/stores', tenantContext, insightsRoutes);

// Storefront search insights (search program Task 6): reads through getSearchInsights (k>=2 floor).
router.use('/stores', tenantContext, searchInsightsRoutes);

// Admin ⌘K palette record lookup (search program P2 Task 18): products, orders, customers.
router.use('/stores', tenantContext, adminSearchRoutes);

// Supplier CRUD (Batch 2 accounting).
// CONTEXT-LESS (Phase 2 candidate, reverted 2026-07-02 PR #499): service
// already self-manages tenant context per-query (see financeRoutes note).
router.use('/stores', tenantContext, suppliersRoutes);

// Purchase Order CRUD + receive (Batch 2 accounting).
// CONTEXT-LESS (Phase 2 candidate, reverted 2026-07-02 PR #499): service
// already self-manages tenant context per-query (see financeRoutes note).
router.use('/stores', tenantContext, purchaseOrdersRoutes);

// Stock Adjustment CRUD + post (Batch 2 accounting).
// CONTEXT-LESS (Phase 2 candidate, reverted 2026-07-02 PR #499): service
// already self-manages tenant context per-query (see financeRoutes note).
router.use('/stores', tenantContext, stockAdjustmentsRoutes);

// Multi-Warehouse stock + order routing (Enterprise — inventory.multi_warehouse).
// KEPT: warehouse.service.ts deliberately relies on the ALS-aware `prisma`
// proxy (not withRlsBypass/runInTenantContext) for its cross-warehouse
// aggregate writes specifically BECAUSE it's called from within this
// router's tenant tx — see the docstring on `syncAggregateInventory`. Safe
// to wrap.
router.use('/stores', tenantContext, warehouseRoutes);

// Expense CRUD + approve/post/reject (Batch 2 accounting).
// CONTEXT-LESS (Phase 2 candidate, reverted 2026-07-02 PR #499): service
// already self-manages tenant context per-query (see financeRoutes note).
router.use('/stores', tenantContext, expensesRoutes);

// Backorder list + cancel (Batch 2 accounting).
// CONTEXT-LESS (Phase 2 candidate, reverted 2026-07-02 PR #499): service
// already self-manages tenant context per-query (see financeRoutes note).
router.use('/stores', tenantContext, backordersRoutes);

// Slug redirect list + delete (#903): read/delete admin surface for
// SlugRedirect rows (recordSlugRedirect is the sole writer — see
// docs/architecture/slug-redirects.md).
router.use('/stores', tenantContext, slugRedirectsRoutes);

// Staff management — store owners add / remove staff members
router.use('/stores/:storeId/staff', tenantContext, staffRoutes);

// Merchant activity log (A24): read-only view of the store's own audit rows
router.use('/stores/:storeId/activity', tenantContext, storeActivityRoutes);

// Merchant billing — plan, subscription, usage vs limits (SP5)
router.use('/stores/:storeId/billing', billingRouteContext, billingRoutes);

// Payment-gateway abandonment retargeting (Enterprise — payment_abandonment)
router.use('/stores/:storeId/payment-abandonments', tenantContext, paymentAbandonmentsRoutes);
// Self-serve lifecycle emails: the merchant's log (admin) and the login-free unsubscribe link (store from the signed token).
router.use('/stores/:storeId/lifecycle-emails', tenantContext, lifecycleEmailsRoutes);
// Ebda Chat connect / disconnect (the only request path that writes the server-owned link).
router.use('/stores/:storeId/whatsapp-link', tenantContext, whatsappLinkRoutes);
router.use('/public/lifecycle-emails', lifecycleEmailsPublicRoutes);
// Studio enquiry form on the marketing site (Ruling CONTACT-FORM-1): nothing stored, mail only.
router.use('/public/contact', contactEnquiryPublicRoutes);
// Guest-safe read-only order summary behind the COD WhatsApp button (Ruling WA-COD-V2-2).
router.use('/public/order-status', orderStatusPublicRoutes);

// Wishlist routes (user-scoped; store comes from an x-store-id header, not
// the URL, so `tenantContext` can't reach it via a mount-path param). RLS
// cutover Phase 1c: the router itself applies `authenticate` +
// `userContext(customerUserId, getStoreIdFromHeader)` — see
// wishlist.routes.ts for the wiring + why. Inert on the current bypass role.
router.use('/wishlist', wishlistRoutes);

// Address routes (user-scoped, no store_id column at all). RLS cutover
// Phase 1c: the router itself applies `authenticate` +
// `userContext(req => req.user!.userId)` — see address.routes.ts for the
// wiring + why. Inert on the current bypass role.
router.use('/addresses', addressRoutes);

export default router;
