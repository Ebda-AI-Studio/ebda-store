# Ebda Program Plan — CLOUD-RUN EDITION (final, 2026-10-03)

> **For agentic workers (Claude Code cloud session):** this file is your whole brief. You cannot see Ahmad's Mac: no local memory, no Umbra CI, no `~/.claude` scripts, no Railway/Cloudflare/Neon logins. Everything you need is here or in the two repos below. Work sub-project by sub-project in the order given. For each sub-project, FIRST write its task-level plan to `docs/plans/<date>-<slug>.md` (superpowers:writing-plans style: exact files, failing test first, minimal code, commit), THEN execute it with superpowers:subagent-driven-development. **Mechanical work on Sonnet; Opus only for SP3's design, security reviews and ambiguous money logic.** Address the owner as "Ahmad". Do NOT start until Ahmad says go.

**Goal:** build Ebda (ebda.app) — Whisky 11's self-serve, Shopify-style store builder for Egypt — to a launch-ready state, with Amelia Aurum as merchant #1.

**Architecture:** clone FWB into `whisky-11/ebda` (full history, FWB as `upstream`), rebrand config-driven, port the backend from Express-on-Railway to Cloudflare Workers, add self-serve onboarding, EGP billing, Egypt-native payments and shipping behind pluggable interfaces, a free WhatsApp tier, the marketing site, docs, help and a status page.

**Tech stack:** Next.js via OpenNext on Cloudflare Workers (app, storefront, marketing); Workers API (Hono or thin router) → Hyperdrive → Neon Postgres with Prisma's pg adapter on workerd; R2; Cloudflare Queues + Cron Triggers; Durable Objects / KV for rate limits and caches; Resend email; Cloudflare for SaaS (custom hostnames) for merchant domains.

---

## 0. Context you would otherwise not have

- **Owner:** Ahmad Sharaf. Company: **Whisky 11** (GitHub org `whisky-11`, Free plan). Ebda is a Whisky 11 product. FWB (Force Website Builder) is the GCC product of Force AI (Whisky 11's GCC operating company) — **read-only upstream for you; never push to it**.
- **Repos:**
  - Source to clone: `ForceAI-KW/force-website-builder` (private monorepo: `apps/api` Express+Prisma, `apps/web` storefront, `apps/admin` merchant dashboard, `apps/orders` PWA, `packages/database` Prisma schema + migrations, `packages/shared`; docs in `docs/`, owner decisions in `docs/RULINGS.md`, conventions in `CLAUDE.md` — READ `CLAUDE.md` and the RLS / tenant-context sections before touching tenancy).
  - Target: `whisky-11/ebda` (private). Branch `plan` holds this file. `main` does not exist yet — SP4 creates it from FWB's history.
- **Brand:** night `#0A0B0C`, Antique Gold `#B08D57`, lift `#CBA873`. Login page art: a "Nile at night from orbit — each light is a store" canvas animation; source script is in `docs/brand/ebda-brief-v2.html` on this branch (second `<script>` block, "Hero: the Nile valley…").
- **Merchant #1:** Amelia Aurum (ameliaaurum.com, jewellery) — free unlimited plan.
- **Hard lessons from FWB (do not repeat):**
  - Tenant resolvers THROW/404 on an unknown store/host — never default to the first store.
  - Under RLS, a per-request DB transaction must not span a slow external call (LLM, payment, carrier, email): Prisma expires interactive transactions after 30 s. Do external calls outside the transaction; keep the user id GUC (`app.current_user_id`) whenever you scope by store.
  - An Express `router.use('/stores/:storeId', …)` is a PREFIX match and silently wraps every later `/stores/:id/*` mount — order mounts deliberately and test it.
  - Tests must run on the SAME driver and runtime as production (Prisma pg adapter on workerd, not the Node Neon driver).
  - `wrangler` ≥ 4.110 needs Node ≥ 22; run a `wrangler deploy --dry-run` in CI on the deploy's Node.
  - Money is integer minor units; VAT is charged AFTER discount; disabled variants do not count as stock.
  - A guard that compares A to B misses what is absent from both; a gate that cannot fail proves nothing — mutation-check every new test (revert the fix → test must fail → restore).
  - `cmd | tail` reports tail's exit code — capture exit codes directly.

## 1. Global Constraints

- Domains: `ebda.app` marketing; `admin.ebda.app` merchant dashboard; **every store at `<slug>.ebda.app`** (free), merchant **custom domains** on top; `api.`, `docs.`, `help.`, `status.`; `whatsapp.` reserved for later. **No `store.ebda.app`.** `.app` is HTTPS-only (HSTS preload).
- Reserved slugs, enforced in validation from the first commit: `app api docs help status whatsapp www admin orders mail cdn assets static store dashboard billing support blog`.
- **Self-serve like Shopify**: signup → live store with no human from Whisky 11.
- **Arabic-first (RTL default) + English**, like FWB.
- **Currency EGP** in integer piastres; VAT 14% (configurable), charged after discount.
- **Payments:** every Egyptian provider (Paymob, Kashier, Fawry, Valu/BNPL, Meeza, wallets) + COD + **InstaPay with ONE manual merchant-confirm step**. Merchant subscription billing in **EGP** via an Egyptian provider (Kashier supports subscriptions); Polar last.
- **Shipping:** every Egyptian carrier with a usable API (Bosta, Aramex, then others from SP10 research) behind one interface.
- **WhatsApp:** free tier only in this plan = `wa.me` click-to-chat (no API). Never unofficial WhatsApp-Web libraries (ban risk). The automated tier = WBS rebranded as the "Ebda WhatsApp platform" — **OUT OF SCOPE now; after Ebda launches.**
- **Pricing/packaging: NOT decided** — build the plans/limits ENGINE; numbers come from SP10 research + Ahmad.
- Production safety: you have no prod credentials; never ask for them in chat; never commit secrets; no real-money transaction without Ahmad's explicit OK.
- Every PR: tests green, `prettier --check` clean on touched files, typecheck clean, a blast-radius note (every renamed/changed identifier grepped across code, tests, docs, CI), and mutation-checked new tests.

## 2. What Ahmad must provide (prerequisites) — check before each SP, stop and ask if missing

| Needed for                               | Item                                                                                                                                     |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Start                                    | Claude GitHub app access: READ `ForceAI-KW/force-website-builder`, WRITE `whisky-11/ebda`                                                |
| SP3 spike deploy (optional), SP4 staging | Cloudflare API token scoped to the Ebda account + `ebda.app` zone; a Neon project for Ebda (connection string as a cloud-session secret) |
| SP5                                      | Kashier (or chosen) merchant-billing sandbox keys; Resend API key + verified `ebda.app` sender                                           |
| SP6                                      | Sandbox keys: Paymob, Kashier, Fawry, Valu (as available)                                                                                |
| SP7                                      | Sandbox keys: Bosta, Aramex (+ others chosen in SP10)                                                                                    |
| SP9                                      | Decision on help-centre tool (build vs hosted) — default: build in-repo MDX                                                              |
| Any time                                 | Pricing numbers (after SP10 brief)                                                                                                       |

Without credentials you still build and test everything against local Postgres + provider sandboxes/mocks; deploy steps wait.

## 3. Budget and checkpoints ($235 cloud credits)

| SP                                | Allocation | Model                              |
| --------------------------------- | ---------- | ---------------------------------- |
| SP10 research                     | $15        | Sonnet                             |
| SP3 design + spike                | $35        | Opus design, Sonnet spike          |
| SP4 clone + rebrand + EGP + hosts | $40        | Sonnet, Opus review of tenancy     |
| SP5 self-serve + billing          | $30        | Sonnet, Opus review of billing     |
| SP6 payments                      | $40        | Sonnet adapters, Opus money review |
| SP7 shipping                      | $20        | Sonnet                             |
| SP8 WhatsApp free tier            | $5         | Sonnet                             |
| SP9 site/docs/help/status         | $25        | Sonnet                             |
| Reserve                           | $25        | —                                  |

After every SP: update `docs/plans/STATUS.md` (done-when evidence, PR links, spend so far, next SP). **If an SP overruns its allocation by 50%, stop and report to Ahmad before continuing.** Prefer fewer, larger subagent tasks over many tiny ones; never run more than 2 parallel subagents.

## 4. Review Focus (each must get a test in the owning SP)

1. **Tenant isolation across `<slug>.ebda.app` and custom domains**, including edge/HTML caches — cache keys include the host; a request for store A can never return store B's data. (SP4)
2. **EGP rounding to the piastre** — VAT after discount, refunds, partial refunds, COD fees. (SP4, SP6)
3. **InstaPay manual step** — awaiting-confirmation orders don't ship, don't count as paid revenue, expire, and can't be confirmed twice. (SP6)
4. **Self-serve abuse** — signup spam, slug squatting on reserved/brand names, card-testing. (SP5)
5. **Provider/carrier outage** — one failing provider degrades one method; checkout still works. (SP6, SP7)

---

## 5. Sub-projects (binding order)

### SP10 — Research (first, cheap, informs the rest)

Briefs in `docs/research/`, sources cited, decision-ready:

1. Pricing & packaging — Shopify, Wuilt, Zid, YouCan, ExpandCart in EGP; what to bundle per plan.
2. Egyptian payment providers — API, sandbox, fees, settlement, KYC, subscriptions support.
3. Egyptian shipping carriers — API, sandbox, COD collection/settlement, label/tracking webhooks.
4. Meta WhatsApp Cloud API pricing for Egypt (current — do not assume).
   **Done when:** four briefs merged on `plan` branch; Ahmad notified for pricing numbers.

### SP3 — Cloudflare backend design + spike (Opus design)

1. `docs/design/cloudflare-backend.md`: every FWB API dependency → Workers equivalent (router; Prisma pg adapter on workerd via Hyperdrive; Redis uses → DO/KV/rate-limiting each with consistency stated; Inngest → Queues/Cron or Inngest→Worker; R2; Resend; payments); host routing model for `<slug>.ebda.app` + Cloudflare-for-SaaS custom hostnames; tenancy (RLS GUCs per query); observability.
2. Spike: port 3 routes (a public catalogue read, a cart write, a payment webhook) and run FWB's buy-flow parity harness (`scripts/buy-flow-parity/`) against them, on workerd (`wrangler dev`/miniflare) with the pg adapter.
3. Decision (full port vs staged) written as a Ruling in `docs/RULINGS.md`.
   **Done when:** design + spike PR open; parity `result.json` green (read the JSON, not the exit code); **Ahmad approves the design** (stop here and wait).

### SP4 — Clone, rebrand, Egypt base, hosts

- `main` = FWB history; `git remote add upstream`; `docs/TWIN-PATHS.md` (shared paths) + `scripts/twin-diff.sh` (lists upstream commits touching shared paths since last sync).
- Config-driven brand (`packages/shared/brand`): name, colours, logo, fonts; zero FWB / Force AI strings visible (CI grep test).
- EGP minor units end to end; Egypt VAT config; Arabic-first default.
- Reserved-slug validation; host resolver for `<slug>.ebda.app` + custom domains (throws on unknown host; tests per Review Focus 1).
- Nile login animation on `admin.ebda.app/login` (respect `prefers-reduced-motion`).
- Backend per SP3 decision.
  **Done when:** Amelia Aurum's catalogue (CSV import) runs on a staging `amelia.ebda.app` (or local equivalent if no CF token yet) with parity green and the no-FWB-branding test passing.

### SP5 — Self-serve onboarding + merchant billing

- Signup → email verify → store name/slug → template → first product → payment method → go live; dashboard setup-guide checklist.
- Plans/limits engine (numbers configurable, filled after SP10).
- EGP subscription billing via the chosen provider; dunning; plan downgrade on non-payment.
- Abuse controls (Review Focus 4).
  **Done when:** a scripted E2E creates a store and takes an order unaided; a timed manual run under 10 minutes is recorded in STATUS.md.

### SP6 — Payments layer

- `PaymentProvider` interface: createPayment, redirect/iframe, verifyWebhook, refund, partialRefund, idempotency keys; shared contract test suite.
- Order: COD → InstaPay (manual confirm, expiry, double-confirm guard) → Paymob → Kashier → Fawry → Valu → others.
- Encrypted per-merchant credentials; sandbox mode per adapter; outage isolation.
  **Done when:** every adapter passes the contract suite in sandbox; Opus money review signed off in the PR; real transactions only with Ahmad's OK.

### SP7 — Shipping layer

- `ShippingCarrier` interface: quote, createShipment+label, cancel, tracking webhook → order status, COD reconciliation.
- Adapters: Bosta → Aramex → others from SP10.
  **Done when:** contract suite green per adapter against sandboxes; COD reconciles to the piastre.

### SP8 — WhatsApp free tier

- `wa.me` click-to-chat: COD order confirmation, order questions, share product; prefilled Arabic/English; merchant number from store settings.
  **Done when:** live in storefront + order emails for every store; no WhatsApp API used.

### SP9 — Marketing site, docs, help, status

- (Superseded for the home page copy, nav and section order by Ruling R-EBDA-COPY-1, 2026-10-07; see `domains-and-marketing-site.md`.) `ebda.app`: nav Features · Solutions · Pricing · Resources · Log in · **Start selling**; hero **"ابدأ بيع أونلاين."** / "Your business, your store, everything in one place."; sections in order: create your store → how EBDA works → store builder → products & inventory → orders → payments → WhatsApp integration → analytics → pricing → customer stories → FAQ → login. Arabic-first. Trust surface: real `/legal`, `/privacy`, `/terms` URLs, `security.txt`, JSON-LD, og:image, `llms.txt`.
- `docs.ebda.app` (API + developer docs), `help.ebda.app` (MDX help centre).
- `status.ebda.app`: its own Worker + storage, fed by external probes, independent of the API.
  **Done when:** all four build and pass Lighthouse/a11y gates; the status page shows an incident when a probe is forced to fail (tested).

### SP11 — UI enhancements (inside SP4/SP5/SP9, tracked)

5-minute onboarding with setup guide; Arabic typography pairing, optional Eastern-Arabic numerals, `ج.م`; mobile-first merchant dashboard (one-thumb order / stock / InstaPay confirm); WhatsApp entry points; COD trust tools (risk flags, OTP confirm, carrier success rate); restrained gold-glow motion with reduced-motion; live split-screen store editor.

### Out of this cloud run (local / Ahmad)

- FWB finish (in flight locally), lessons→skills, Umbra stability (pre-launch Phases 0–2).
- DNS, Cloudflare zone, provider KYC/accounts, Facebook account.
- **Launch (SP12):** production deploy, Amelia migration, monitoring/alerting/log drain, backups + DR drill, consent/erasure/export, five testing layers — run with Ahmad, after this cloud run.
- **Ebda WhatsApp platform (WBS rebrand):** after launch.

## 6. Order and evidence

| Order | SP   | Evidence                                                       |
| ----- | ---- | -------------------------------------------------------------- |
| 1     | SP10 | 4 briefs merged                                                |
| 2     | SP3  | design + spike PR; parity green; **Ahmad approval (gate)**     |
| 3     | SP4  | Amelia catalogue on staging/local host; no-branding test green |
| 4     | SP5  | unaided E2E store+order; <10 min timed                         |
| 5     | SP6  | contract suite green per adapter; Opus money sign-off          |
| 6     | SP7  | contract suite green; COD reconciles                           |
| 7     | SP8  | wa.me tier live                                                |
| 8     | SP9  | four hosts built; status-page failure test                     |

## 7. Kickoff prompt (paste into the cloud session when Ahmad says go)

> Ahmad: read `docs/plans/2026-10-03-ebda-program-plan.md` on branch `plan` of `whisky-11/ebda` and execute it in order, starting with SP10. Check section 2 prerequisites before each sub-project and stop to ask if one is missing. Write `docs/plans/STATUS.md` after every sub-project, including spend. Stop at the SP3 design gate for my approval. Budget $235 per section 3.
