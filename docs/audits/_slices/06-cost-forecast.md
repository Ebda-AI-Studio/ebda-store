## 6. Cost Forecast & Scaling

### Executive Summary

At current idle state (fewer than 100 merchants, under 10k MAU), Ebda Store's infrastructure runs at roughly **$15–30/mo** in actual cash outlay — most services are on free tiers, and Railway + Vercel absorb the baseline compute. At 10k MAU across ~100–200 active merchants, total run-rate climbs to **$160–250/mo**, driven primarily by Railway scaling, Neon moving to the paid Launch tier, Resend overage, and Inngest crossing the free step cap. At 100k MAU the bill reaches **$1,100–1,800/mo**, with Railway multi-instance costs and Neon compute becoming the dominant line items. Neither burst scenario (10k in 1hr / 100k in 1hr across the platform) inherently blows up the monthly bill — burst costs are per-use and mostly absorbed by existing overage rates — but both expose hard architectural ceilings that cause **service degradation or outages** before the invoice grows meaningfully.

**🚨 Critical flag for the acquirer:** the platform is currently running on Vercel Hobby. Vercel explicitly prohibits commercial use (SaaS, ecommerce, payment processing) on Hobby. **The platform is in violation of Vercel's terms of service today.** Upgrading to Pro at $20/mo (one seat) resolves this and is the minimum viable change before any investor or acquirer runs due diligence. This is the single highest-priority cost action.

---

### Per-Service Pricing Model

#### 6.1 Vercel

**Current plan:** Hobby ($0/mo). **Terms violation:** Vercel's Fair Use Guidelines explicitly prohibit any project that processes payments or generates revenue on Hobby. Ebda Store processes merchant orders, charges subscription fees, and is deployed as a commercial SaaS — textbook violation. Vercel can suspend account without notice.

**Hobby limits (2026):** Bandwidth 100GB/mo (hard stop), Function invocations 1M/mo, Image transformations 5K/mo, Active CPU 4hrs/mo, Edge requests 1M/mo, Blob storage 1GB.

**Pro plan:** $20/mo per seat. Pro includes: 1TB bandwidth then $0.15/GB, function invocations + credit then $0.60/1M, image transforms $0.05/1K, Fluid Compute on active execution time.

**Ebda Store usage profile:**

- 2 projects: `force-admin` (low traffic, merchants only) and `force-web` (customer-facing, multi-tenant)
- `force-web` is bandwidth driver: product images via Next/Image, SSR renders, ISR
- Per-merchant custom domain attachment requires Pro

**Cost scenarios:**
| Scenario | Vercel Cost |
|---|---|
| Idle (today, <10k MAU) | $0 (Hobby — terms violation) → must be **$20/mo** (Pro) |
| 10k MAU | $20/mo (Pro, within bandwidth) |
| 100k MAU | $20–60/mo (Pro + ~300GB extra bandwidth = ~$45 overage; image transforms ~$5) |
| 10k in 1hr burst — 1 store | Absorbed by Pro limits |
| 100k in 1hr burst — platform | ~50–100GB spike = $7–15 overage |

**Bottleneck at scale:** Image optimization at 100k MAU. 100 items × 5 sizes × 1000 visitors = 500K transforms in one session. Pro's $0.05/1K adds $25/day. **Recommendation:** aggressive `stale-while-revalidate` + pin image dimensions.

#### 6.2 Railway

**Current plan:** Hobby ($5/mo, credit toward usage). Pricing: RAM $10/GB/mo, CPU $20/vCPU/mo, Network egress $0.05/GB, Volume storage $0.15/GB/mo.

**Current deployment:** 1 API container + 1 Redis instance, both always-on.

**Observed throughput ceiling (2026-05-04 load test):** **190 req/s sustained** on cached path, 1GB RAM/shared CPU. Cold-cache path (Neon hit): ~40–60 req/s before p95 degrades past 500ms. 190 req/s = 16.4M req/day max.

**Typical resource utilization:**

- RAM: ~0.6 GB under load × $10 = $6/mo
- CPU: ~0.3 vCPU avg × $20 = $6/mo
- Redis: ~256MB = $2.56/mo
- **Total: ~$14.56/mo**

**Cost scenarios:**
| Scenario | RAM/CPU profile | Railway cost |
|---|---|---|
| Idle (<100 merchants, ~1k req/day) | 0.4GB / 0.1 vCPU | ~$6/mo |
| 10k MAU (~1k req/hr avg, peaks 3k) | 0.8GB / 0.4 vCPU | ~$16/mo |
| 100k MAU (~10k req/hr avg, peaks 30k) | Needs 2× instances: 1.6GB × 2, 0.8 vCPU × 2 | ~$64/mo + Pro upgrade |
| 10k in 1hr burst (1 store) | 2,778 req/s peak → **above 190 req/s single-instance ceiling** | Requires horizontal scale OR prior cache warming |
| 100k in 1hr burst (platform) | 27,778 req/s peak → **catastrophically above ceiling** | Needs 15+ instances at burst peak |

**Upgrade path:** Pro ($20/mo) unlocks multiple replicas + priority support. Each 1GB/0.5vCPU replica adds ~$14/mo. 3-replica setup handles ~570 req/s sustained.

**The 190 req/s ceiling means:** 10k simultaneous visitors × 3 API calls each = 30k requests in 60s = 500 req/s needed. **Current single instance cannot handle this.** Edge cache must absorb product listing + category reads.

#### 6.3 Neon (PostgreSQL)

**Current plan:** Free tier. Limits: 0.5GB/project, 100 CU-hrs/mo (autoscale 0.25–2 CU), 10 branches.

**Paid tiers (2026):**

- **Launch:** $0.106/CU-hour, $0.35/GB-mo storage, 10 branches, 100GB free egress then $0.10/GB
- **Scale:** $0.222/CU-hour (higher ceiling up to 56 CU), $0.35/GB-mo, 25 branches

**Ebda Store DB size estimate:**

- Current: <0.5GB
- 10k MAU (100 merchants, 200 products each, 1k orders/merchant): ~2–3GB
- 100k MAU (1000 merchants): ~20–30GB

**Compute hours:** Storefront reads Redis-cached (120s+ TTL); Neon sees cache misses + writes only. At 10k MAU with hot Redis: 20–40 CU-hrs/mo. At 100k MAU: sustained ~200+ CU-hrs/mo.

**Cost scenarios:**
| Scenario | Plan | Neon cost |
|---|---|---|
| Idle (<0.5GB, <100 CU-hrs) | Free | $0 |
| 10k MAU (~2GB, ~150 CU-hrs) | Launch | $0.35 × 2 + $0.106 × 150 = **$16.60/mo** |
| 100k MAU (~25GB, ~600 CU-hrs) | Launch | $0.35 × 25 + $0.106 × 600 = **$72.35/mo** |
| 10k in 1hr burst | Autoscale 2 CU for 1hr = $0.21 spike | Negligible |

**Bottleneck signal:** At 10k MAU, branch cap (10 on Launch) binding before cost. Snapshot workflow fills 9. Scale plan ($0.222/CU-hr, 25 branches) needed for operational headroom. Effective 100k MAU = **$141.95/mo on Scale**.

#### 6.4 Cloudflare R2

**Pricing:** Free 10GB-mo + 1M Class A + 10M Class B + zero egress. Paid: $0.015/GB-mo, $4.50/1M Class A, $0.36/1M Class B.

**Ebda Store usage:** Per merchant ~20.5MB (hero ~500KB + 100 product images × 200KB).

| Merchants        | Storage | R2 Cost      |
| ---------------- | ------- | ------------ |
| 10 (today)       | ~205MB  | Free         |
| 100 (10k MAU)    | ~2GB    | Free         |
| 1,000 (100k MAU) | ~20.5GB | **$0.16/mo** |
| 10,000           | ~205GB  | **$2.93/mo** |

**Operations at 100k MAU:** Repeat requests to same R2 URL = CDN cache hits, don't count. With reasonable cache-hit rate (>90%), effective cost ~$10/mo. **Zero egress is major cost advantage vs S3.**

#### 6.5 Sentry

**Free (Developer):** 5K errors/mo, 5M tracing spans/mo, 50 session replays, 30-day retention.

**Team:** $26/mo. 50K errors/mo, 5M spans, 50 replays, 90-day retention.

| Scenario       | Sentry cost                        |
| -------------- | ---------------------------------- |
| Idle / 10k MAU | $0 (free tier)                     |
| 50k+ MAU       | $26/mo (Team)                      |
| 100k MAU       | $26/mo (Team, unless errors spike) |

#### 6.6 Resend

**Free:** 3,000 emails/mo, **100 emails/day cap**, 1 domain. **Pro:** $20/mo for 50,000 emails, 10 domains, no daily cap. Overage: $0.90/1K.

**Email volume:**

- 10k MAU: 100 merchants × 20 orders/day = 2,000/day = **60K/mo** → exceeds free tier 20×. Pro ($20) + 10K overage × $0.90/1K = **$29/mo**
- 100k MAU: 1,000 merchants × 20/day = 20,000/day = **600K/mo** → Pro 50K + 550K overage × $0.90/1K = **$515/mo**. Most significant cost driver at scale.
- **Free tier is exhausted at ~5 active merchants** (100 emails/day cap is the binding constraint).

**This is the most overlooked cost risk. Free tier breaks at ~5 active merchants.**

#### 6.7 OneSignal

**Free:** Unlimited mobile push, 10K web push subscribers per send, single active journey, 6 segments. **Growth:** $19/mo + $0.012/MAU mobile + $0.004/subscriber web + $1.50/1K email overage.

| Scenario                 | OneSignal cost                               |
| ------------------------ | -------------------------------------------- |
| <10K total web push subs | $0                                           |
| 10k MAU (1–2K subs)      | $0                                           |
| 100k MAU (~10–15K subs)  | Growth $19/mo + $0.004 × 15,000 = **$79/mo** |

**Bottleneck:** Free tier 10K subscribers-per-send. At 100k MAU with 15% push opt-in = 15K subscribers — Growth required.

#### 6.8 Inngest

**Free (Hobby):** 50K function steps/mo, 5 concurrent, 50 realtime connections, 3 users. **Pro:** $75/mo, 1M steps included. Overage: $0.000050/step at 1M–5M.

**Step volume:** Order created → 5 steps fanout. At 10k MAU: 100 merchants × 20 orders/day × 5 = 10K steps/day = **300K/mo** → 6× free cap. At 10 active merchants × 20 orders × 5 = 30K/mo (near free cap).

**Nightly analytics rollup (issue 2348, 2026-10-01):** 3 steps per accounting-enabled store (cohort, funnel, RFM each in its own step since issue 2293 — 3× the old single step) plus 1 + ceil(N/500) on the fan-out cron. At 200 stores: ~601 steps/night ≈ **18K/mo** — about a third of the free cap on its own. Each store runs in its own function run (≤3 at a time), so no single run grows with the store count.

**Bulk AI sweeps wildcard:** 100 merchants × 200 products = 20K steps in one sweep. At 10k MAU during active-adoption period → 2M steps/mo → Pro required.

| Scenario                                     | Inngest cost                |
| -------------------------------------------- | --------------------------- |
| Idle (few orders, no sweeps)                 | $0                          |
| 10k MAU (active selling + occasional sweeps) | **$75/mo (Pro)**            |
| 100k MAU                                     | **$175/mo (Pro + overage)** |

#### 6.9 Google Gemini (gemini-2.5-flash-lite)

**Free (2026):** 15 RPM, ~500 RPD (the real 429 ceiling we hit in prod on `gemini-flash-lite`; Google nominally publishes higher), 250K TPM. **Paid:** $0.10/1M input + $0.40/1M output.

**Ebda Store usage per call:** ~250 input + 200 output = 450 tokens avg. Daily cap of 450 calls × 450 tokens ≈ 200K tokens/day — comfortably under the **$0.105/day / $3.15/mo** ceiling implied by the older 1,000-call cap.

| Scenario                           | Gemini cost |
| ---------------------------------- | ----------- |
| Idle (free tier, <1K RPD)          | $0          |
| 10k MAU (500 calls/day)            | ~$1.50/mo   |
| 100k MAU (20K calls/day paid tier) | ~$63/mo     |

**The free-tier daily ceiling for `gemini-flash-lite` is ~500 RPD** (the real 429 we hit in prod, not Google's higher published number). `AI_DAILY_REQUEST_CAP=450` is set safely UNDER that so our friendly quota error trips before Google's raw 429. A single merchant bulk-sweeping ~450 products consumes the entire platform's daily allowance. At 100k MAU with many simultaneous sweeps, paid tier mandatory.

#### 6.10 Payment Providers (Per-Transaction)

Standard rates (2026):
| Provider | KNET | Visa/MC domestic | International |
|---|---|---|---|
| MyFatoorah | 2.0% | 3.5% | 3.5%+ |
| Tap | 2.75% | 2.75% | 3.25% + FX |
| Hesabe | ~2.5% | ~3.5% | — |
| UPayments | ~2.5% | ~3.0% | — |

**Platform revenue model:** Ebda Store charges SaaS subscription. Payment fees pass through to merchants — Ebda Store doesn't take a cut of GMV. At 10k MAU with EGP 15 avg order × 2/visitor/mo = $1M GMV/mo, processing fees $27,500/mo borne by merchants.

#### 6.11 Domains

Force-owned: ebda.app + app/store subdomains ~$30/yr. Per-merchant custom domains: merchant pays own registrar ~$10–15/yr (Vercel handles SSL).

**Platform domain cost: ~$30/yr flat. Negligible.**

#### 6.12 GitHub Actions

**Free (2026, private repo):** 2,000 Linux minutes/mo. Overage: $0.010/min.

**Ebda Store CI:** Run ~10–15 min per push. 5–10 pushes/day = 1,500–4,500 min/mo. 2K free exhausted within 2 weeks of active dev.

| Scenario                       | GH Actions cost |
| ------------------------------ | --------------- |
| Light dev (<100 pushes/mo)     | $0              |
| Active sprint (300+ pushes/mo) | $25–35/mo       |

---

### Cost Summary Table

| Service           | Free at                 | 10k MAU plan | $/mo at 10k | 100k MAU plan    | $/mo at 100k | Breaks first at burst                 |
| ----------------- | ----------------------- | ------------ | ----------- | ---------------- | ------------ | ------------------------------------- |
| Vercel            | **Never (commercial)**  | Pro (NOW)    | $20         | Pro              | $30–60       | Image transforms at 100k              |
| Railway           | Idle only               | Hobby→Pro    | $16         | Pro + 3 replicas | $64          | **190 req/s ceiling — 1 store viral** |
| Neon              | <100 merchants          | Launch       | $17         | Launch/Scale     | $72–142      | Branch cap (10)                       |
| Cloudflare R2     | <500 merchants          | Free         | $0          | Free–paid        | $10          | Class B if CDN cache cold             |
| Sentry            | Up to 50k MAU           | Free         | $0          | Team             | $26          | Error volume at 100k                  |
| Resend            | **<2 active merchants** | Pro          | $29         | Pro+Scale        | $515         | 100 emails/day cap                    |
| OneSignal         | <10K subs               | Free         | $0          | Growth           | $79          | 10K subscriber send cap               |
| Inngest           | Idle only               | Pro          | $75         | Pro+overage      | $175         | Bulk AI sweeps exhaust 50K steps      |
| Gemini Flash Lite | <1K calls/day           | Free→paid    | $2          | Paid             | $63          | **15 RPM + 1K RPD free cap**          |
| Payment providers | — (pass-through)        | Pass-through | $0          | Pass-through     | $0           | —                                     |
| Domains           | $30/yr flat             | Flat         | $2.50       | Flat             | $2.50        | —                                     |
| GitHub Actions    | <200 pushes/mo          | Free/overage | $0–25       | Free/overage     | $0–25        | —                                     |

---

### Total Monthly Cost

| Scenario                      | Compute    | DB      | Hosting  | Email    | Queue    | Push     | Error | AI  | Storage | CI  | **Total**                        |
| ----------------------------- | ---------- | ------- | -------- | -------- | -------- | -------- | ----- | --- | ------- | --- | -------------------------------- |
| Idle (today)                  | $6         | $0      | $20\*    | $0       | $0       | $0       | $0    | $0  | $0      | $0  | **$26/mo**                       |
| 10k MAU                       | $16        | $17     | $20      | $29      | $75      | $0       | $0    | $2  | $0      | $12 | **$171/mo**                      |
| 100k MAU                      | $64        | $72–142 | $45      | $515     | $175     | $79      | $26   | $63 | $10     | $25 | **$1,074–1,144/mo**              |
| Burst: 10k in 1hr (1 store)   | ~$0.10     | ~$0.21  | Absorbed | Absorbed | Absorbed | Absorbed | —     | —   | —       | —   | **~$0.31 one-off**               |
| Burst: 100k in 1hr (platform) | Pre-scaled | ~$2     | ~$3      | Absorbed | Absorbed | Absorbed | —     | —   | —       | —   | **~$5–20 one-off if pre-scaled** |

\*Vercel Hobby is $0 but must upgrade to Pro ($20) immediately due to commercial use violation.

---

### Bottleneck Cascade — What Breaks First

#### Scenario A: 10,000 unique visitors in 1 hour on a single store

Arrival: 10K × 5 API calls = 50K requests in 3,600s = **~14 req/s average, 70 req/s burst (5× peak)**.

Cascade:

1. **Vercel CDN absorbs static assets** — Next.js ISR cached pages served from edge. No Railway involvement. Holds.
2. **Cache miss requests hit Railway** — uncached PDP, cart ops, checkout. At 70 req/s burst, within 190 req/s ceiling. **Railway holds IF Redis cache is warm.**
3. **Redis cold-start risk** — Railway deploys restart container, cache cold. All reads fall through to Neon. Prisma connection pool (default 10) becomes bottleneck. **Connection pool exhaustion is first failure point under cold cache.**
4. **Inngest queue backs up** — 200+ purchases enqueue 1,000+ steps. At 5 concurrent (free tier), queue grows. Jobs complete slowly, no hard failure, order confirmation emails delay minutes.
5. **Gemini RPM cap** — if merchant runs bulk AI sweep during burst, 15 RPM cap throttles. Isolated from storefront path.

**Verdict A:** Stack handles 10k in 1hr on a single store **IF Redis warm + Prisma pool tuned** (recommend `connection_limit=25` in DATABASE_URL). Cold cache = single point of failure. Pre-warm strategy required before campaigns.

#### Scenario B: 100,000 unique visitors in 1 hour across platform

Arrival: 100K × 5 API calls = 500K requests in 3,600s = **~139 req/s average, 694 req/s burst**.

Cascade (fastest failure first):

1. **Railway API container — hard ceiling at 190 req/s** — single instance saturated at 139 avg; at 694 burst **completely overwhelmed**. Queue grows, event loop saturates, health checks fail. Railway restarts container. **API goes down within minutes.** First/most severe failure.
2. **Redis connection pool** — Railway restart may disconnect Redis. Re-connection storm adds 5–15 sec downtime.
3. **Neon connection exhaustion** — Default pool ~100 connections. 190 concurrent Railway requests holding Prisma connections = pool full. New requests get `connection pool exhausted` errors.
4. **Vercel function timeout** — SSR functions calling overloaded Railway return 502/504. 10-second default timeout means pages error to visitors.
5. **Inngest steps pile up** — 10K+ order events enqueued. At 5 concurrent (free), 2,000-step backlog. Pro 100+ concurrent drains in minutes.
6. **Resend rate limit** — 100 emails/day free cap hit in 30 min. Order confirmations fail silently (fire-and-forget risk per `feedback-fire-and-forget-bug-mask.md`).
7. **Gemini RPM** — 15 RPM cap. Concurrent AI sweeps fail with 429s. `retries: ≥2` on Inngest compounds queue depth.

**Required pre-conditions to survive Scenario B:**

- Railway: minimum 4 replicas (Pro, ~$60/mo) for 760 req/s burst
- Neon: `?connection_limit=25&pool_timeout=30` in DATABASE_URL + Scale plan
- Inngest: Pro ($75/mo) for 100+ concurrent steps
- Resend: Pro ($20/mo) to remove 100/day cap
- Redis: Single Railway instance is SPOF — consider Redis Cloud fallback or Railway Pro persistent volume

**Without these changes, 100k in 1hr across platform = platform-wide outage within 3–5 minutes.**

---

### 12-Month Cost Trajectory

Linear MAU growth from ~1k (today) to 10k MAU over 12 months:

| Month | MAU    | Railway | Neon | Vercel | Resend | Inngest | Other | **Total** | **Cumulative** |
| ----- | ------ | ------- | ---- | ------ | ------ | ------- | ----- | --------- | -------------- |
| M1    | 1,000  | $6      | $0   | $20    | $5     | $0      | $5    | **$36**   | $36            |
| M2    | 1,800  | $8      | $0   | $20    | $8     | $0      | $5    | **$41**   | $77            |
| M3    | 2,600  | $10     | $5   | $20    | $12    | $0      | $7    | **$54**   | $131           |
| M4    | 3,400  | $11     | $8   | $20    | $15    | $75     | $8    | **$137**  | $268           |
| M5    | 4,200  | $12     | $10  | $20    | $18    | $75     | $10   | **$145**  | $413           |
| M6    | 5,000  | $13     | $12  | $20    | $20    | $75     | $10   | **$150**  | $563           |
| M7    | 5,800  | $14     | $14  | $22    | $22    | $75     | $12   | **$159**  | $722           |
| M8    | 6,600  | $14     | $15  | $23    | $24    | $75     | $12   | **$163**  | $885           |
| M9    | 7,400  | $15     | $16  | $23    | $26    | $75     | $12   | **$167**  | $1,052         |
| M10   | 8,200  | $15     | $16  | $24    | $27    | $75     | $15   | **$172**  | $1,224         |
| M11   | 9,000  | $16     | $17  | $25    | $28    | $75     | $15   | **$176**  | $1,400         |
| M12   | 10,000 | $16     | $17  | $25    | $29    | $75     | $15   | **$177**  | $1,577         |

**Inngest cliff at M4** ($0 → $75) is the most significant cost step-change. 12-month cumulative to reach 10k MAU: **$1,577**.

---

### Per-Merchant Cost Contribution

**At 10k MAU with 100 active merchants:**

- Infra: $171/mo / 100 merchants = **$1.71/merchant/mo**
- 70–80% gross margin target = merchant contributes **$2.14–2.44/mo** in revenue to cover infra
- Realistic SaaS pricing (3–4× loaded cost): **$15–30/merchant/mo**

**At 100k MAU with 1,000 merchants:**

- Infra: $1,100/mo / 1000 merchants = **$1.10/merchant/mo** (scale efficiency)
- 70% margin = $3,667/mo MRR needed = **$3.67/merchant**
- Realistic SaaS pricing at this scale: **$49–99/merchant/mo**

**Egypt market calibration:** Shopify ~$29–79/mo. Salla ~25–99 EGP/mo (~$80–320). Ebda Store's cost structure supports **29–49 EGP/mo ($95–160)** price point with 70%+ gross margins at 100k MAU.

---

### Top 3 Cost Risks at Scale

**Risk 1: 🚨 Vercel Hobby Terms Violation (IMMEDIATE)**
Platform running commercial SaaS on Vercel Hobby, which explicitly prohibits payment-processing projects. Vercel can suspend both projects without notice. **Live legal and operational risk.** Upgrade to Pro ($20/mo) before any investor or customer due diligence.

**Risk 2: Resend Email Cost Explosion at Scale ($515/mo at 100k MAU)**
Email cost grows linearly with order volume — largest variable cost at scale. At 100k MAU = $515/mo line item, comparable to entire rest of stack. Options: (a) per-merchant SMTP provider (merchants pay own Resend/Mailgun), (b) volume deal, (c) email batching.

**Risk 3: Single-Instance Railway SPOF (Architectural)**
Single 1GB Railway container handling all API traffic has no horizontal redundancy. Any Railway deploy = 15–30 sec downtime. Memory leak crashes service. No load balancer, no health-check routing, no graceful drain. At 10k MAU = reliability risk; at 100k MAU = availability guarantee violation. Redis SPOF on same Railway internal network. **Action:** Railway Pro + minimum 2 replicas + Redis persistent volume or external managed Redis.
