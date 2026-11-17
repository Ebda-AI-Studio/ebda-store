# Ebda — Product Roadmap

**Internal document. Last updated: 2026-06-01.**

---

## Shipped

### Platform & Infrastructure

- [x] Monorepo architecture (npm workspaces) — apps: api, admin, web, orders; packages: database, shared, ui, config
- [x] Multi-tenancy with Row-Level Security (RLS) — database-level tenant isolation via AsyncLocalStorage + Prisma Proxy; non-owner `ebda_app` role enforces RLS in production
- [x] Custom domains — auto-provisioned per merchant via Cloudflare-for-SaaS Custom Hostnames with SSL
- [x] Role-based access — Super Admin (platform-wide), Store Admin (single store), Customer (storefront)
- [x] Horizontal-scaling readiness — Redis adapter plumbing, Redis-backed rate-limiting, pooled DB connections; see `docs/SCALING.md`
- [x] Upgrade-marketing gate — merchants who open a plan-gated feature see an on-brand "Available on the [Plan] plan" upsell page instead of a silent redirect

### Commerce Core

- [x] Product management — categories, variants, inventory tracking, image galleries
- [x] Product discount engine — per-product discount dropdown (None / Percentage % / Fixed EGP) with live discounted-price preview; `compareAtPrice` is now derived automatically
- [x] Order lifecycle — cart, checkout, payment processing, status transitions with notification triggers
- [x] Abandoned cart recovery — sweeps website carts + WhatsApp DM carts in one unified job
- [x] Upsell & cross-sell — AI co-purchase signal driving "Frequently Bought Together" recommendations
- [x] Returns & refunds — merchant-side return request management and refund processing
- [x] Coupons — fixed + percentage discount codes

### Storefront

- [x] 5 themes — Modern, Classic, Minimal, Bold, Elegant — each RTL-compatible and independently configurable
- [x] Page builder — drag-and-drop section ordering + bilingual copy editing; Navigation links, Footer links, and Category page config are all consolidated inside the visual editor (`/stores/:id/builder`; the form Page Builder was retired in Task 12, 2026-10-22)
- [x] Dark mode — system `prefers-color-scheme` detection + manual toggle
- [x] RTL / bilingual — Arabic + English with full right-to-left layout support; every database field has separate AR and EN columns
- [x] PWA — service worker, push notification support, per-merchant installable app icon/name
- [x] SEO — sitemap, robots.txt, JSON-LD structured data, meta descriptions, Open Graph
- [x] Blog — built-in blog with admin management, homepage carousel, and SSR metadata

### AI Features (Google Gemini Flash Lite)

- [x] Auto-translate products (EN ↔ AR) — per-field and bulk sweep across entire catalog
- [x] SEO title + description generation — store, categories, products, bilingual
- [x] AEO meta rewrite — conversational rewrites for AI search engines (Google SGE, Perplexity, ChatGPT)
- [x] FAQ + How-To guide generation — bulk sweep per product
- [x] Category suggestion — AI-suggested chips on product edit
- [x] Review spam detection, auto-translation, summarization, owner-response drafting
- [x] Reorder + dead-stock AI — Gemini-powered reorder recommendations and dead-stock flags in Stock hub
- [x] Catalogue field sweeps (2026-07-03) — 5 bulk AI-tools sweeps on the AI Tools page, each smart-skipping already-filled entities: product FAQs (bilingual FAQ pairs per product), category assignment (uncategorized products only, picks from the store's own categories, never invents one), image alt-text (Gemini Vision, capped 4 images/product), product excerpts (1-2 sentence bilingual summary derived from the full description, provenance-stamped), product tags (up to 5 tags/product, reuses existing store tags case-insensitively, never deletes)

### Accounting Module (Professional plan)

- [x] Chart of Accounts — double-entry bookkeeping organized by account categories (27 default accounts seeded on onboarding; system accounts are read-only — merchants may add custom child accounts under them)
- [x] Journal entries — auto-posted on paid orders (sales, cost of goods, refunds); manual entry UI
- [x] Profit & Loss — live P&L report reflecting actual store activity
- [x] Expense tracking — categorized expense entry with receipt attachment and monthly summary (Professional+)
- [x] Invoicing — Egypt-compliant invoice generation, bilingual layout, PDF export (Professional+)
- [x] Tax reports — VAT/sales-tax export per reporting period (Enterprise+)
- [x] Multi-currency — FX tracking with automatic EGP conversion at book-keeping level (Enterprise+)
- [x] Profit anomaly watch — AI-driven margin watcher that flags below-cost sales (Enterprise+)
- [x] Bank reconciliation — CSV/OFX import with automated ledger matching (Enterprise+)
- [x] Payment audit trail — append-only `payment_events` table with raw provider webhook payload; every provider event preserved

### Inventory (tiered by plan)

- [x] Stock tracking — per-product counts, low-stock badge, manual adjustment (Starter+)
- [x] Low-stock alerts — auto-email when product drops below per-product threshold (Professional+)
- [x] Backorder — accept orders for out-of-stock products; queue for fulfillment (Professional+)
- [x] Multi-warehouse — per-warehouse stock counts, proximity-based order routing (Enterprise+)
- [x] Barcode scanning — mobile barcode scan for stock receipt, order picking, audit (Enterprise+)
- [x] Purchase orders — supplier PO workflow with cost capture, receive-against-PO, supplier ledger (Enterprise+)
- [x] Bulk adjustments — CSV/Excel import for stock reconciliation (Enterprise+)

### Plan Tier System

- [x] Four plan tiers — `free` (grace/lapsed state), `starter`, `professional`, `enterprise`
- [x] Layered feature baselines in `packages/shared/src/plan-baselines.ts` — strict superset invariant unit-tested
- [x] Super-admin per-store feature overrides — preserved across plan changes

### Egypt Payment Stack

- [x] Paymob, Kashier, Fawry — cards + wallets
- [x] InstaPay — manual payments with confirmation
- [x] Cash on Delivery — flat-fee option, no provider account required
- [x] Smart payment links — typeahead product picker + custom amount, all 4 gateways

### WhatsApp & Bot

- [x] WhatsApp order notifications — 4 lifecycle templates (placed, confirmed, shipped, delivered), per-event per-channel toggles
- [x] Customer DM ordering bot — Gemini NLU, natural Arabic/English, voice transcription, product photo matching, returning-customer personalization
- [x] One-click Meta Commerce catalog provisioning — auto-creates catalog under the platform parent BM via Graph API; no merchant BM setup required
- [x] Bot analytics — funnel, intent breakdown, LLM stats, date range pickers
- [x] Origin-aware delivery — WhatsApp-origin orders receive WhatsApp-only (no placeholder email)
- [x] Abandoned cart recovery sweeps both website + WhatsApp DM carts

### Communication

- [x] SMS notifications — Unifonic API with Redis queue + circuit breaker (Enterprise+)
- [x] Push notifications — W3C Web Push (VAPID), per-store browser subscriptions (Professional+)
- [x] Transactional email — branded sender per merchant domain via Resend
- [x] Newsletter broadcast — send to subscriber list from admin; XLSX/CSV export

### Shipping

- [x] Carrier integrations on the provider catalog — Bosta, ShipBlu, Mylerz, Aramex (+ manual delivery): booking, label, quote, tracking, cancel; each stays "coming soon" until verified against its sandbox (iCarry removed)
- [x] Aramex integration — rate calculation and tracking
- [x] Egypt shipping zones — governorate and city structure
- [x] Cash on delivery — flat-fee option

### Other

- [x] Affiliate program (Enterprise+) — referral tracking, commission management, invite emails
- [x] Loyalty program (Professional+) — points earn/redeem, configurable redemption rate
- [x] Marketing pixels — Meta/Facebook, Google, TikTok with server-side Conversions API (CAPI) for Meta and TikTok; fires only after cookie consent
- [x] Floating widget (Enterprise+) — sticky multi-action button; position, direction, colors, labels all configurable
- [x] Analytics hub — overview, cohort analysis, conversion funnel, customer segments, product analytics, date range pickers

---

## Next

These items are sequenced from `docs/HANDOFF-2026-06-01.md`. Priority order is approximate.

### Near-term (design-gated or partially implemented)

- [ ] **Product discount fields** — B1–B4: compare-price → active discount, percentage/dinar dropdown, live preview cell in the product form; requires schema change (discount type/value on product model) + storefront price resolution logic
- [ ] **Settings → visual editor full consolidation** (the form Page Builder is retired; the editor is the one surface) — A1 Footer Links, A2 Storefront Navigation, A3 Branding social/SEO de-dup, A4 Category Pages access restoration, A5 editor preview covers all unsaved changes (currently homepage + layout only)
- [ ] **Search program** (`docs/plans/done/2026-10-15-semantic-search.md`) — P0 in review: Arabic-normalised trigram search on storefront, typeahead and admin product search, merchant-set search words, searches-with-no-results insights; P1 AI search terms + embeddings (hybrid ranking, off until the eval bar holds), P2 customer/order search, P3 catalogue import. Rulings SEARCH-\* in `docs/RULINGS.md`
  - **Launch gates (privacy; each must be closed before the storefront search goes live for real shoppers):**
  - [x] **SEARCH-T5-8** — DONE (Ruling SEARCH-URL-1, `fix/launch-blockers-privacy`): the storefront → API search term moved out of the URL into the `X-Search-Query` header (list + typeahead), the search page address carries no term, `/search` is noindex. The API still accepts the deprecated `?search=`/`?q=` for one release (remove with the admin ones). After the first deploy, re-check the `api` Worker's invocation log for `search=` values.
  - [ ] **SEARCH-P2-5 contract migration** (follow-up, not a launch gate) — after the P2 deploy is confirmed, drop the unused per-key trigram indexes (`orders_guest_first_name / last_name / phone_trgm_idx`, `users_first_name / last_name / phone_trgm_idx`) and the `ebda_order_search_ids` kinds `'guest'` / `'customers'`; never in the same deploy as the code that stopped calling them. Until then every write to orders and users pays for six redundant GIN indexes.
  - [ ] **SEARCH-P2 deprecated query forms** (follow-up) — remove the `?search=` / `?q=` fallbacks of the customers and orders routes one release after the header-sending admin and Orders-PWA builds ship (SEARCH-P2-9).
  - [x] **SEARCH-T5-9 residual** — DONE (Ruling PIXEL-CONSENT-1, `fix/launch-blockers-privacy`): no pixel loads or fires on a URL carrying a term, email, phone or one-time token; every `track*` helper is gated on the consented provider; the search URL carries no term. The Search event still sends a non-PII-shaped term as a parameter to consenting shoppers' pixels (SEARCH-T5-9).

### Infrastructure

- [ ] **Horizontal scaling enablement** — Socket.io needs `@socket.io/redis-adapter` (cross-instance events currently break with >1 replica); 14 module-level `setInterval` crons need leader-election before replicas > 1 can be enabled; Railway replica config is ready
- [ ] **RLS fail-closed** — drop the `IS NULL` policy escape; prerequisite is migrating all 28 super-admin cross-tenant reads to `withRlsBypass`, then rewriting the 41 `IS NULL` policies to explicit `app.bypass_rls` form

---

## Tech Stack

| Layer               | Technology                                                       |
| ------------------- | ---------------------------------------------------------------- |
| **API**             | Express.js 4 + TypeScript                                        |
| **Admin Dashboard** | Next.js 16 (App Router)                                          |
| **Storefront**      | Next.js 16 (App Router)                                          |
| **Database**        | Neon PostgreSQL (serverless) + Prisma ORM                        |
| **Cache & Queues**  | Redis                                                            |
| **Storage**         | Cloudflare R2 (S3-compatible)                                    |
| **Real-time**       | Socket.io (WebSocket notifications)                              |
| **Auth**            | Custom JWT (HTTP-only cookies)                                   |
| **Async Jobs**      | Inngest                                                          |
| **AI**              | Google Gemini Flash Lite (`GOOGLE_GENERATIVE_AI_KEY`)            |
| **Payments**        | Paymob, Kashier, Fawry, InstaPay                                 |
| **Email**           | Resend                                                           |
| **Push**            | OneSignal + Web Push (VAPID)                                     |
| **Hosting**         | Cloudflare Workers (admin + storefront + orders) + Railway (API) |
| **Testing**         | Vitest (332+ tests)                                              |

---

_Last Updated: 2026-06-01_
