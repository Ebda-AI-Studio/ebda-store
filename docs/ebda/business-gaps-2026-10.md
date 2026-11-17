# Ebda business gaps — draft for Ahmad (2026-10-10)

**Status: DRAFT for owner review.** Nothing here is a decision. Owners, first buyer, channel and every target below are OPTIONS with a recommendation; Ahmad picks. Framing (Ahmad): _"The biggest remaining proof is customers signing up, activating, paying and renewing with little intervention. Every gap below should end with a named owner and a measured number, not an opinion."_

**Labels used on every number**

- **MEASURED** — read from code, config or a repo doc in this session (file cited). A MEASURED price that the doc itself took from a search snippet stays marked _(source unverified)_.
- **ASSUMED** — my estimate; the assumption is written next to it. Replace with a measurement before acting on it.
- **NOT MEASURABLE YET** — no data exists; the item says what would make it measurable.

**Fixed inputs**

| Input                  | Value                                                                                                                                                       | Label                                                                                                         |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Plans (monthly, EGP)   | Basic 1,490 / Growth 3,490 / Business 9,990                                                                                                                 | MEASURED — `docs/plans/done/2026-10-05-pricing-decisions.md`                                                  |
| Annual                 | 9 months prepaid (25% off): 13,410 / 31,410 / 89,910 → Basic effective 1,117.50/month                                                                       | MEASURED, same file                                                                                           |
| Platform commission    | 0 bps, COD never cut, no public free plan, 14-day trial on Growth                                                                                           | MEASURED, same file                                                                                           |
| Basic order cap        | 300 orders/month, soft then hard after 7 days                                                                                                               | MEASURED, same file + `packages/shared/src/schemas/plan-limits.ts`                                            |
| AI on Basic            | Every AI capability is in every paid baseline (AI-first policy 2026-07-21)                                                                                  | MEASURED — `packages/shared/src/plan-baselines.ts` (`STARTER_CORE`; Basic maps to the `starter` feature tier) |
| WhatsApp on every plan | `wa.me` link only, no Meta API calls → Meta cost 0                                                                                                          | MEASURED — pricing decisions + STATUS SP8                                                                     |
| FX                     | 1 USD = 52.24 EGP (mid-market 2026-10-03)                                                                                                                   | MEASURED from `docs/ebda/research/pricing-and-packaging.md` (source: Wise/XE search summary)                  |
| Production is live     | `ebda.app`, `store.ebda.app` 200; `api.ebda.app/health` → `commit 430cf318…` = tip of `main`, `server: cloudflare`                                          | MEASURED — curl, 2026-10-10 02:43 UTC                                                                         |
| Paying merchants today | Unknown. Merchant #1 (Amelia Aurum) is on hidden `founding_free` (pays 0). I did not query production (no read-only prod SQL path was used in this session) | NOT MEASURED                                                                                                  |

---

## 1. Customer acquisition

**The gap:** no channel, no owner, no sign-up target, and no recorded funnel rate exists anywhere in the repo (searched `docs/` for acquisition / channel / go-to-market / marketing budget: nothing for Ebda). The research briefs cover pricing, gateways, carriers and WhatsApp — none covers acquisition.

### Owner options

| Option                                                | For                                                                                                                                        | Against                                                                                              |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| **A. Ahmad, founder-led (recommended first 8 weeks)** | Zero cash; he hears the objections himself (pillar 1 says his feedback IS the market signal); the first 10 payers need hand-holding anyway | His hours are shared with Ebda AI Studio + Whisky 11; caps volume (see math below)                   |
| B. Part-time Egyptian growth/community hire           | Scales the outreach; Arabic-native in merchant groups                                                                                      | Costs cash before conversion rates are known; needs a playbook that does not exist yet               |
| C. Channel partner (Bosta, Paymob, Kashier)           | They already hold Egyptian merchant relationships; Ebda already integrates all three (BYO keys)                                            | No commercial relationship exists; partner merchant-base sizes are **unverified**; months, not weeks |

The Ebda AI Studio / Whisky 11 network is **not** a fit as the first channel: it is Egypt/GCC, and Ebda is EGP-only and Egypt-registered (Ruling OPERATOR-1, `docs/ebda/brand/operator.md`). Useful only for warm intros to Egyptian contacts.

### Which ONE channel first — recommendation (not a decision)

**Founder-led direct outreach to Instagram/Facebook sellers who already take orders by DM + COD.** The argument, by evidence rather than taste:

1. **The product already fits that seller's current workflow** (MEASURED): COD on every plan, `wa.me` order hand-off on every plan, Arabic-first RTL storefront, Bosta carrier adapter. Nothing new must be built to pitch them.
2. **They are findable without a budget**: an Instagram shop with "اطلب في الخاص" / DM-to-order is a visible, filterable signal. Paid ads need a known lead→trial→paid rate to set a bid; Ebda has none.
3. **Each conversation is a measurement**: reply rate, trial start, activation and paid conversion are all observable per merchant, which is exactly the data needed to decide whether to spend on channel B or C.

Paid Meta ads are option 2, only after week 4 produces an activation rate. If Ahmad wants a parallel test: ASSUMED 10,000 EGP/month budget at an ASSUMED 30–150 EGP per lead → 65–330 leads/month, with an unknown lead→trial rate. Not recommended until the funnel below has real rates.

### Weekly sign-up target (all inputs ASSUMED unless marked)

- Capacity assumption: Ahmad spends **5 h/week** on outreach; ~10 min per personalised DM + follow-up → **~30 conversations/week**.
- ASSUMED reply 20–30% → 6–9 replies; ASSUMED 40–60% of replies start a trial → **3–5 trial sign-ups/week**.
- **Proposed target: 5 trial sign-ups/week for weeks 1–4**, then re-set from the measured rates.
- Downstream (ASSUMED): 50% activate (definition below), 30% of activated pay at trial end → **~0.75 paying merchants/week**. At that rate, 50 paying merchants takes ~67 weeks — which is the quantitative reason founder-led outreach is a measurement phase, not the growth plan.

### How it gets measured (data already exists)

| Funnel step | Definition                                                                                                                                                         | Source                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Sign-up     | Store created                                                                                                                                                      | `stores.created_at`                                                                    |
| Activation  | All required setup-guide items done (`add_product`, `brand`, `shipping`, `payment`, `test_order`) — or stricter: first non-test order within the trial             | `packages/shared/src/setup-guide.ts` computes `done` from real data (MEASURED: exists) |
| Paid        | Subscription `trialing` → `active`                                                                                                                                 | `apps/api/src/services/billing/account.service.ts` statuses                            |
| Renewed     | Second successful billing period                                                                                                                                   | billing events / subscription period                                                   |
| Channel     | **Missing:** no `acquisition_source` is recorded at sign-up. Minimal fix: a UTM / "how did you hear about us" field on signup, shown on the super-admin store list | NOT MEASURABLE YET                                                                     |

**Needs Ahmad:** pick the owner (A/B/C), confirm or replace the 5 h/week and 5 sign-ups/week assumptions.

---

## 2. First target customer

Format: _"<buyer> loses <EGP/month> to <problem>; Ebda removes it."_

### Candidate A — Instagram/Facebook DM-COD seller (fashion, accessories, home), ~150–300 orders/month

> **A DM-COD seller loses ~6,000–8,000 EGP/month to a moderator who takes orders by hand in DMs; Ebda removes it.**

- Number: ASSUMED Cairo order-taker/moderator salary 6,000–8,000 EGP/month (no source in repo; ask 5 sellers what they pay). Ebda Basic = 1,490 → net ~4,500–6,500 EGP/month saved if the storefront replaces the manual intake. Lost-order cost (DMs answered late) is real but NOT MEASURABLE without the seller's numbers.
- Fit: 300 orders/month Basic cap matches this size (MEASURED cap).
- Weakness: the most price-sensitive segment; EasyOrders charges ~2.1 EGP/order with no subscription (MEASURED from research, _source unverified_) — at 200 orders that is ~420 EGP/month, under Basic's 1,490.

### Candidate B — Merchant paying an agency/freelancer for a custom site (WooCommerce / bespoke)

> **A merchant with an agency-built store loses ~2,250–7,000 EGP/month (build amortised over 12 months + hosting/maintenance) to a site they cannot edit themselves; Ebda removes it.**

- Number: ASSUMED 15,000–50,000 EGP one-off build + 1,000–3,000 EGP/month hosting/maintenance → 2,250–7,170 EGP/month over a 12-month horizon. No repo source; one quote from two Cairo agencies would settle it.
- Fit: pillar 1 (customisation without a developer) is exactly their pain.
- Weakness: sunk-cost bias — they already paid the build; switching is a migration project.

### Candidate C — Egyptian merchant on Shopify Basic paying in USD

> **An Egyptian Shopify Basic merchant doing ~100,000 EGP/month online loses ~4,000–5,500 EGP/month to a USD subscription, a 2% third-party-gateway surcharge and paid Arabic/COD apps; Ebda removes it for 1,490 EGP and 0% commission.**

- Number breakdown:
  - Shopify Basic $39/month = **2,035 EGP** (MEASURED from research, _source unverified_; annual-billed $29 = 1,515).
  - Third-party gateway surcharge 2% on Basic (Paymob/Kashier are third-party; Shopify Payments availability in Egypt _unverified_) → **2,000 EGP** on 100,000 EGP online GMV (MEASURED rate, _source unverified_; GMV ASSUMED).
  - Apps for Arabic/RTL, COD confirmation, local shipping: ASSUMED $10–30/month → **~520–1,570 EGP**.
  - Total ~4,555–5,605 EGP/month vs Ebda Basic 1,490 + 0 bps → **~3,000–4,100 EGP/month saved**. At ~700 EGP average order (ASSUMED), 100,000 EGP ≈ 143 orders — inside Basic's 300 cap.
- Fit: already pays for SaaS (willingness to pay proven); the saving is visible on their own Shopify invoice; Shopify-format CSV import already works (MEASURED: STATUS item 2).
- Weakness: segment size in Egypt is unknown; USD exposure may already push some of them off Shopify on their own.

### Recommendation (labelled as mine, not a decision)

**Pick C for the first 10 paying merchants, A as the volume segment after.** Reason: the first proof Ahmad needs is _pays and renews with little intervention_. C's loss is on an invoice the buyer already receives (no estimate to argue about), they already pay monthly, and importing their catalogue is a solved path — so the time from sign-up to activation should be the shortest of the three. A is the bigger market but its number rests on an assumed salary and it is most exposed to per-order competitors. Settle C's segment size first: count Egyptian `.myshopify.com` / Shopify-CDN storefronts reachable from the outreach list in week 1.

**Needs Ahmad:** pick the buyer; validate the one ASSUMED input of the chosen sentence with 5 real merchants.

---

## 3. Integration proof (shared account across products)

**Status: NOT VERIFIED end-to-end.** A live walkthrough earlier in this same session was blocked at **email verification** — no real inbox was available to receive the verification mail — so the full journey (sign-up → verify → store → product → order → WhatsApp hand-off → shared account into a second product) has **not** been driven live. I did not re-attempt it.

Context (MEASURED):

- The "other products" are not built yet: Ruling PRODUCT-NAME-1 names Ebda Store as the product and Ebda Chat / CRM / ERP as **future** products, with `id`, `accounts`, `hub` slugs reserved (`docs/RULINGS.md`). A shared account across products therefore cannot be proven today beyond the Store itself; what CAN be proven now is the single-product journey plus the `wa.me` hand-off.
- `docs/ebda/launch-readiness-2026-10-05.md`: signup/email verification passed locally with captured dev mail; "Real sender/domain delivery still needs verification."
- STATUS item 7: the human timed onboarding run (<10 min target) has not been recorded.

**Next unblock step:** a real inbox Ahmad controls (or an inbound test mailbox) for the walkthrough, plus confirmation that the Resend sender for `ebda.app` is verified in production. Then drive the journey live and record one number: **minutes from landing page to first test order** (target <10, STATUS item 7). The shared-account half stays NOT VERIFIABLE until a second Ebda product exists.

| Owner option                                                         | Measured number                                |
| -------------------------------------------------------------------- | ---------------------------------------------- |
| Ahmad provides the inbox + Resend confirmation; agent drives the run | Wall-clock minutes, sign-up → first test order |

---

## 4. Exceptions / support load

**There is no support data.** Searched the repo for support tickets, support logs, ops-cost or minutes-per-merchant: none. The Prisma schema has no support/ticket model. This is a pre-launch product with one non-paying merchant. **I am not putting a minutes-per-merchant number in this section**; section 5 uses a clearly labelled assumption band instead.

What already exists and is countable today (MEASURED — these give exception COUNTS, not minutes):

| Exception class                 | Existing signal / surface                                                                                                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Failed subscription payment     | Dunning (`dunningAttempts`, `nextRetryAt`, `past_due`) in `apps/api/src/services/billing/`                                                                                      |
| **Manual subscription payment** | InstaPay / bank / cash renewals are **recorded by a super-admin by hand**, 3-day grace (`account.service.ts`, `period.ts`) — one human action per renewal per non-card merchant |
| Failed transactional email      | Super-admin `/email-queue` (exhausted retries, replayable)                                                                                                                      |
| Failed SMS                      | Super-admin `/sms-queue`                                                                                                                                                        |
| Payment-webhook failures        | Super-admin `/webhook-events` (replay)                                                                                                                                          |
| Onboarding stuck                | Setup-guide `done` per item (`packages/shared/src/setup-guide.ts`) — shows WHERE a merchant stalls                                                                              |
| Refunds                         | Order/refund records (merchant-side; Ebda carries no money for card sales, BYO keys)                                                                                            |
| WhatsApp connection problems    | Today only a `wa.me` link (no API connection to fail); the inherited WABA admin is flagged OFF for every store (Ruling WHATSAPP-OFF-1) and is not visible to merchants          |

The single biggest "little intervention" risk visible in code is the **manual renewal path**: every merchant who pays by InstaPay/bank instead of card costs a human action every month. Kashier card recurring is the automatic path, and recurring-agreement enablement on Ebda's account still needs written confirmation from Kashier (research brief + STATUS item 9; the latest Kashier commit #54 is a **sandbox** run).

### Minimal instrumentation needed before this can be measured

1. **Tag taxonomy** (applied to every support contact, any channel): `billing.card_failed`, `billing.manual_renewal`, `onboarding.email_verify`, `onboarding.domain`, `onboarding.gateway_keys`, `onboarding.shipping`, `catalog.import`, `payments.refund`, `whatsapp.link`, `bug`, `how_to`, `other`.
2. **A timer**: each contact logged with merchant, tag, start/stop minutes. Cheapest version for the first ~20 merchants is a support-inbox label set + a one-row-per-contact log. The durable version is a `support_events` table with a super-admin page (per the every-data-has-a-UI rule) that also auto-records the countable signals above (dunning attempt, manual renewal recorded, email-queue failure for that store).
3. **Two derived numbers**, weekly: **support minutes per active merchant per month**, and **% of renewals needing a human** (manual renewals ÷ all renewals). The second one is Ahmad's "little intervention" number directly.

| Owner option                                                              | Measured number                                                   |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Ahmad (he is the support desk until merchant ~20) — or the hire from §1 B | Support minutes / merchant / month; % of renewals needing a human |

---

## 5. Profitability / unit economics (Basic, 1,490 EGP/month)

Zero commission means Ebda's ONLY revenue is the subscription; merchants' gateway and carrier fees are their cost, not Ebda's. Costs below are Ebda's cost to serve one merchant per month.

### 5.1 AI (Gemini `gemini-flash-lite-latest`)

| Fact                         | Value                                                                                                        | Label                                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Per-store daily token budget | 200,000 tokens/day (in + out) → ceiling **6,000,000 tokens/month**                                           | MEASURED — `apps/api/src/config/index.ts` `AI_DAILY_TOKEN_BUDGET_PER_STORE` default                            |
| Per-store daily request cap  | 150 non-cached requests/day                                                                                  | MEASURED — `apps/api/src/lib/ai-quota.ts`                                                                      |
| Platform caps                | 450/day × key count; **20,000/month across ALL stores**                                                      | MEASURED, same file                                                                                            |
| Price                        | $0.10 / M input, $0.40 / M output                                                                            | ASSUMED (the example in `docs/ENVIRONMENT.md`; the `-latest` alias can move to a model with different pricing) |
| Cost tracking                | `ai_usage.cost_micros` is NULL unless `AI_MODEL_RATES` is set; whether it is set in production: NOT VERIFIED | MEASURED (code)                                                                                                |

- **Ceiling per merchant:** 6M tokens at 80/20 in/out = $0.96 = **~50 EGP**; all-output worst case $2.40 = **~125 EGP**. Holds only on paths that call the budget check — that every Gemini path does is NOT VERIFIED.
- **Typical (ASSUMED 5–15% of ceiling): ~3–20 EGP/merchant/month.**
- **The cap binds before the cost does:** 20,000 requests/month is 200/merchant at 100 merchants and 20/merchant at 1,000. The defaults are free-tier guardrails; serving the AI pillar at scale means moving to paid Gemini billing and raising the caps, which converts this line from ~0 to the estimate above.
- **Answer-engine (paid Perplexity/OpenAI):** platform-wide caps 200 calls/day each (MEASURED, `docs/ENVIRONMENT.md`) → max 12,000 calls/month. At an ASSUMED $0.005–0.01/call → **$60–120/month platform ceiling (~3,100–6,300 EGP)**. This is fixed-ish, so it hurts most at low merchant counts.

### 5.2 Infra (USD/month, ASSUMED usage, list prices from memory/the Ebda Store cost forecast)

Stack per Ruling LEGAL-3 (`docs/RULINGS.md`): Cloudflare Workers/KV/Queues/R2, Neon, Resend, Sentry, Inngest, Gemini, PostHog, OneSignal — "Railway and Redis are not used". (Note: the project `CLAUDE.md` still describes the API on Railway; the live `/health` response carries no Railway headers, `server: cloudflare`. INFERRED that Workers serves it; reconcile the docs separately.) Usage shapes borrowed from `docs/audits/_slices/06-cost-forecast.md` (written for Ebda Store, so ASSUMED transferable).

| Line                                   | 10 merchants | 100 merchants | 1,000 merchants | Basis (ASSUMED unless noted)                                                        |
| -------------------------------------- | ------------ | ------------- | --------------- | ----------------------------------------------------------------------------------- |
| Cloudflare Workers (paid plan + usage) | $5           | $5–15         | $30–80          | $5 base, 10M requests included                                                      |
| Neon (Launch, usage)                   | $5–15        | $30–60        | $100–300        | ~$0.14/CU-h (forecast doc used $0.106) + $0.35/GB-mo                                |
| Resend                                 | $0–20        | $20–30        | $100–515        | free 100/day breaks at ~5 active stores (forecast); Ebda Store 1k-store figure $515 |
| Inngest                                | $0           | $0–75         | $75–150         | free 50k steps; ~300k steps at 100 stores (forecast)                                |
| Sentry / PostHog / OneSignal           | $0           | $0–26         | $26–260         | free tiers → paid at scale                                                          |
| CF for SaaS custom hostnames           | $0           | $0            | $0–90           | first 100 free, then ~$0.10 each (if all 1,000 use a custom domain)                 |
| R2                                     | $0           | $0            | $1–10           | zero egress                                                                         |
| **Total USD**                          | **$10–40**   | **$55–206**   | **$332–1,405**  |                                                                                     |
| **Per merchant (EGP @52.24)**          | **52–209**   | **29–108**    | **17–73**       |                                                                                     |

Excluded as company opex, not cost-to-serve: Claude Max, GitHub Team, domains (already-paid base plans).

### 5.3 Collecting the subscription (Ebda's own gateway cost)

Kashier 2.75% + EGP 3 per transaction, plus 14% VAT on Kashier's fee (MEASURED from research, _source unverified_; Paymob publishes the same 2.75% + 3):

- Basic monthly: 40.98 + 3 = 43.98, + VAT 6.16 → **~50 EGP (3.4%)**.
- Basic annual 13,410: → 423.82 once → **~35 EGP/month**.
- InstaPay manual renewal: ~0 gateway fee but a human action per renewal (cost moves into support, §4).

### 5.4 Support

NOT MEASURED (§4). Band used below, every input ASSUMED: Cairo support agent 15,000–25,000 EGP/month, ×1.3 loaded, 160 productive h → **2.0–3.4 EGP/minute**; minutes/merchant/month 60–180 (10 merchants, onboarding-heavy), 30–90 (100), 15–45 (1,000).

| Merchants | Support EGP/merchant/month |
| --------- | -------------------------- |
| 10        | 120–612                    |
| 100       | 60–306                     |
| 1,000     | 30–153                     |

### 5.5 Gross margin on Basic (1,490 EGP, monthly card billing)

| Merchants | Infra  | AI (Gemini) | Answer-engine ceiling share | Billing fee | Support | **Cost/merchant (low–high)** | **Gross margin (low–high cost)** | Central estimate    |
| --------- | ------ | ----------- | --------------------------- | ----------- | ------- | ---------------------------- | -------------------------------- | ------------------- |
| 10        | 52–209 | 3–125       | 0–627                       | 50          | 120–612 | **225–1,623**                | **85% … −9%**                    | ~650 EGP → **~56%** |
| 100       | 29–108 | 3–125       | 0–63                        | 50          | 60–306  | **142–652**                  | **90% … 56%**                    | ~295 EGP → **~80%** |
| 1,000     | 17–73  | 3–125       | 0–6                         | 50          | 30–153  | **100–407**                  | **93% … 73%**                    | ~185 EGP → **~88%** |

Reading it:

- **Support is the largest and the only unmeasured line.** At every merchant count it is the biggest swing item; the infra bill is small next to it. The §4 instrumentation is what turns this table from a band into a number.
- **At 10 merchants the worst case is negative**, driven by the answer-engine ceiling spread over few stores plus founder support time. The answer-engine caps (200/day each) are a dial Ahmad can lower until volume justifies them.
- **Annual billing** drops Basic revenue to 1,117.50/month; at the 100-merchant central cost (~280 EGP after the cheaper annual fee) margin is ~75%.
- **VAT is a revenue-side cliff, not a cost**: ASSUMED Egyptian VAT registration threshold EGP 500,000/year (verify with an accountant) ≈ **28 Basic merchants on monthly billing** (1,490 × 12 = 17,880 each). The locked decision adds 14% on top once registered → Basic becomes 1,698.60 EGP to the buyer, which is above Shopify Basic annual-billed (1,515) in the §2 C comparison.

**Owner option:** Ahmad, until a finance owner exists. **Measured number to replace this table:** monthly cost-to-serve per merchant from (a) the Cloudflare/Neon/Resend/Inngest invoices ÷ active merchants, (b) `SUM(ai_usage.cost_micros)` per store once `AI_MODEL_RATES` is set in production, (c) the Kashier fee lines, (d) the §4 support minutes.

---

## Needs Ahmad (one line each)

1. **Acquisition:** owner (founder-led recommended for 8 weeks) and the 5 trial sign-ups/week target; add `acquisition_source` at sign-up so the channel is measured.
2. **First buyer:** recommended C — Shopify Basic merchant losing ~4,000–5,500 EGP/month; Ebda saves ~3,000–4,100. Validate with 5 merchants.
3. **Integration:** NOT VERIFIED; blocked at email verification. Unblock = a real inbox + confirmed Resend sender, then record minutes to first test order (target <10). Shared account is unprovable until a second Ebda product exists.
4. **Support:** no data exists. Approve the tag taxonomy + timer; the key numbers are support minutes/merchant/month and % of renewals needing a human. Get Kashier recurring enablement in writing.
5. **Unit economics:** central Basic gross margin ~56% / ~80% / ~88% at 10 / 100 / 1,000 merchants; support is the dominant unmeasured cost, and the 20,000/month platform AI cap binds before AI cost does.
