import { Router } from 'express';
import authRoutes from './auth.routes';
import mfaRoutes from './mfa.routes';
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
import returnRoutes from './return.routes';
import publicRoutes from './public.routes';
import paymentRoutes from './payment.routes';
import paymentSettingsRoutes from './payment-settings.routes';
import uploadRoutes from './upload.routes';
import adminRoutes from './admin.routes';
import adminAnswerEngineRoutes from './admin-answer-engine.routes';
import couponRoutes from './coupon.routes';
import shippingRoutes from './shipping.routes';
import taxRoutes from './tax.routes';
import customerGroupRoutes from './customer-groups.routes';
import promotionRoutes from './promotion.routes';
import bundleRoutes from './bundle.routes';
import loyaltyRoutes from './loyalty.routes';
import pwaRoutes from './pwa.routes';
import inventoryRoutes from './inventory.routes';
import bulkRoutes from './bulk.routes';
import variantRoutes from './variant.routes';
import categoryRoutes from './category.routes';
import aiRoutes from './ai.routes';
import wishlistRoutes from './wishlist.routes';
import addressRoutes from './address.routes';
import featureRoutes from './feature.routes';
import notificationRoutes from './notification.routes';
import abandonedCartRoutes from './abandoned-cart.routes';
import recommendationRoutes from './recommendation.routes';
import shippingCarrierRoutes from './shipping-carrier.routes';
import affiliateRoutes from './affiliate.routes';
import newsletterRoutes from './newsletter.routes';
import onesignalRoutes from './onesignal.routes';
import storeLayoutRoutes from './store-layout.routes';
import publicStoreLayoutRoutes from './public-store-layout.routes';
import pagesRoutes from './pages.routes';
import typographyRoutes from './typography.routes';
import wbsIntegrationRoutes from './wbs-integration.routes';
import agentCredentialRoutes from './agent-credential.routes';
import merchantKeyRoutes from './merchant-key.routes';
import waTemplatesRoutes from './wa-templates.routes';
import paymentLinksRoutes from './payment-links.routes';
import financeRoutes from './finance.routes';
import smartLayerRoutes from './smart-layer.routes';
import insightsRoutes from './insights.routes';
import suppliersRoutes from './suppliers.routes';
import purchaseOrdersRoutes from './purchase-orders.routes';
import stockAdjustmentsRoutes from './stock-adjustments.routes';
import warehouseRoutes from './warehouse.routes';
import expensesRoutes from './expenses.routes';
import backordersRoutes from './backorders.routes';
import botAnalyticsRoutes from './bot-analytics.routes';
import staffRoutes from './staff.routes';
import paymentAbandonmentsRoutes from './payment-abandonments.routes';
import mcpRoutes from './mcp.routes';
import mcpAdminRoutes from './mcp-admin.routes';
import { tenantContext } from '../middleware/tenant-context';

const router = Router();

// Public routes (no auth required)
router.use('/public', publicRoutes);
router.use('/public', publicStoreLayoutRoutes);

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
router.use('/auth', authRoutes);
// MFA sub-routes: enroll/begin, enroll/verify, verify (challenge), disable.
// Mounted under /auth/mfa so the full path is /api/v1/auth/mfa/*.
// Must come AFTER auth routes and BEFORE any catch-all.
router.use('/auth/mfa', mfaRoutes);

// Payment routes
router.use('/payments', paymentRoutes);

// Payment settings (super admin)
router.use('/payment-settings', paymentSettingsRoutes);

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
// UUID check) or — worse, post-force_app-cutover — silently scope every
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
// `ResendService.provisionStoreDomain` / `removeStoreDomain` /
// `verifyAndRefreshDomain`). Trapping a slow third-party call inside a 30s
// RLS interactive transaction risks blowing the timeout. This router is
// CONTEXT-LESS — Phase 2 candidate; the CRUD-only handlers are fine, only
// the domain endpoints need per-route (not per-router) context wiring.
router.use('/stores', tenantContext, storeRoutes);

// Store-scoped routes — tenantContext wraps all downstream handlers in an RLS transaction
router.use('/admin/stores/:storeId/layout', tenantContext, storeLayoutRoutes);
router.use('/stores/:storeId/products', tenantContext, productRoutes);
router.use('/stores/:storeId/categories', tenantContext, categoryRoutes);
router.use('/stores/:storeId/ai', tenantContext, aiRoutes);
router.use('/stores/:storeId/typography', tenantContext, typographyRoutes);
router.use('/stores/:storeId/cart', tenantContext, cartRoutes);
router.use('/stores/:storeId/orders', tenantContext, orderRoutes);
// Customers export (.xlsx). Mounted at /stores/:storeId so the route
// has access to storeId via mergeParams.
router.use('/stores/:storeId', tenantContext, customersRoutes);
router.use('/stores/:storeId/reviews', tenantContext, reviewRoutes);
router.use('/stores/:storeId/analytics', tenantContext, analyticsRoutes);
router.use('/stores/:storeId/answer-engine', tenantContext, answerEngineRoutes);
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
// docs/plans/2026-07-02-rls-cutover.md (Phase 1a) and
// docs/audits/2026-07-02-tenancy-rls-auth.md (F2).
//
// inventoryRoutes is the exception: REWORKED 2026-07-02 (surgical
// follow-up, PR #499) — its `router.param('storeId', tenantContext)` was
// REVERTED because `reconcileCountSession` (services/barcode-scan.service.ts)
// calls `runInTenantContext` internally for the cycle-count reconcile path,
// which would double-nest a second `basePrisma.$transaction` inside the
// outer per-request tx. inventoryRoutes stays CONTEXT-LESS — Phase 2
// candidate.
router.use('/stores', tenantContext, couponRoutes);
router.use('/stores', tenantContext, shippingRoutes);
router.use('/stores', tenantContext, taxRoutes);
router.use('/stores', tenantContext, customerGroupRoutes);
router.use('/stores', tenantContext, promotionRoutes);
router.use('/stores', tenantContext, bundleRoutes);
router.use('/stores', tenantContext, loyaltyRoutes);
router.use('/stores', tenantContext, pwaRoutes);
router.use('/stores', tenantContext, inventoryRoutes);
router.use('/stores', tenantContext, bulkRoutes);
router.use('/stores', tenantContext, variantRoutes);

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
router.use('/public', notificationRoutes);

// Abandoned cart routes (admin + public recovery)
router.use('/stores', tenantContext, abandonedCartRoutes);
router.use('/public', abandonedCartRoutes);

// Recommendation routes (admin + public).
// CONTEXT-LESS (Phase 2 candidate, reverted 2026-07-02 PR #499):
// the admin recalculate endpoint fires `recommendationService.recalculateFBT`
// fire-and-forget (no await) so the response can return before it finishes —
// wrapping the request would let the outer tx commit while the detached
// work is still running, then hit "transaction already closed".
router.use('/stores', tenantContext, recommendationRoutes);
router.use('/public', recommendationRoutes);

// Shipping carrier routes (admin + public tracking).
// CONTEXT-LESS (Phase 2 candidate, reverted 2026-07-02 PR #499):
// createShipmentForOrder / cancelShipment / updateShipmentStatus /
// testConnection all call external courier APIs (Aramex, iCarry) in-request —
// slow third-party calls have no place inside a 30s RLS transaction.
router.use('/stores', tenantContext, shippingCarrierRoutes);
router.use('/public', shippingCarrierRoutes);

// Affiliate routes (admin + public apply/track)
router.use('/stores', tenantContext, affiliateRoutes);
router.use('/public', affiliateRoutes);

// Newsletter admin routes (list + CSV export). Public signup is in
// public.routes.ts so visitors don't need a JWT to subscribe.
// CONTEXT-LESS (Phase 2 candidate, reverted 2026-07-02 PR #499): the
// broadcast endpoint loops `ResendService.sendBrandedEmail` in chunks of 50,
// sequentially awaited in-request — a large subscriber list can run well
// past 30s, which would blow the RLS transaction's timeout.
router.use('/stores', tenantContext, newsletterRoutes);

// WBS integration routes (Force AI Store ↔ WBS bridge config).
// CONTEXT-LESS (Phase 2 candidate, reverted 2026-07-02 PR #499): handlers
// call the external WBS backend via `fetch` in-request.
router.use('/stores', tenantContext, wbsIntegrationRoutes);

// Agent (MCP) write-credential admin — mint / rotate / revoke the per-store
// `x-agent-key`. Mounted next to the WBS integration routes because it is the
// same shape of per-store credential admin (`/stores/:id/integrations/...`).
// `tenantContext` here is the same bare-mount no-op it is on every `/stores`
// line above (Express only fills params declared in the MOUNT path); tenant
// scoping comes from `requireStoreAccess` inside the router.
router.use('/stores', tenantContext, agentCredentialRoutes);
router.use('/stores', tenantContext, merchantKeyRoutes);

// Phase 7: WhatsApp templates admin (generate / sync / status)
router.use('/stores/:id/wa-templates', tenantContext, waTemplatesRoutes);

// Phase 7: merchant-initiated payment links via WhatsApp
router.use('/stores/:id/payment-links', tenantContext, paymentLinksRoutes);

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

// Insights routes (cohort + funnel + rfm + dashboard — Batch 4).
// CONTEXT-LESS (Phase 2 candidate, reverted 2026-07-02 PR #499):
// `generateInsightNarration` calls Gemini in-request — an external AI call
// has no place inside a 30s RLS transaction.
router.use('/stores', tenantContext, insightsRoutes);

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

// Phase 5 bot intelligence: proxy bot analytics from WBS to admin frontend.
// CONTEXT-LESS (Phase 2 candidate, reverted 2026-07-02 PR #499): the handler
// calls the external WBS backend via `fetch` (10s timeout) in-request.
router.use('/stores', tenantContext, botAnalyticsRoutes);

// Staff management — store owners add / remove staff members
router.use('/stores/:storeId/staff', tenantContext, staffRoutes);

// Payment-gateway abandonment retargeting (Enterprise — payment_abandonment)
router.use('/stores/:storeId/payment-abandonments', tenantContext, paymentAbandonmentsRoutes);

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
