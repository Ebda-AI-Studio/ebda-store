# Cyber-Liability Insurance Brief — Force Website Builder (FWB) / ForceAI

**Status:** Procurement-prep artifact (finding D1, 2026-07-09 Builder Reality Audit)
**Owner:** Ahmad Sharaf, ForceAI-KW
**Last updated:** 2026-07-09

---

## 1. Purpose + disclaimer

This document is **not insurance advice, not legal advice, and not a purchased policy**. It exists so
Ahmad can hand it to a broker or underwriter and get quotes back in one round-trip instead of three —
every question a cyber-insurance application typically asks is pre-answered below.

All dollar figures, coverage limits, and carrier names in this brief are **indicative**, drawn from
public market research (cited inline) as of July 2026. **Nothing here should be treated as a bindable
quote or a confirmed appetite from any named carrier.** Actual pricing, terms, exclusions, and even
whether a given carrier will write a Kuwait-domiciled SaaS at all depend on underwriting review that
only a licensed broker/carrier can perform. Where research could not confirm a fact (e.g., "does Carrier
X actually write Kuwait risk"), it is flagged explicitly as **"confirm with broker"** rather than guessed.

Kuwait's cyber insurance market itself is thin — ~90%+ of Kuwaiti SMEs currently carry no cyber cover
at all, per a Kuwait-market research estimate ([Ken Research, Kuwait Cyber Insurance Market
2019–2030](https://www.kenresearch.com/kuwait-cyber-insurance-market)) — so expect more manual
underwriting and fewer instant-bind online quotes than a US/UK founder would experience.

---

## 2. What cyber-liability insurance covers, and why FWB needs it

Cyber policies split into **first-party** (costs FWB itself incurs after an incident) and **third-party**
(claims brought against FWB by others, or regulatory action). Both apply to FWB's actual risk surface.

### First-party coverage → FWB scenario

| Coverage                         | What it pays for                                                                                     | Concrete FWB scenario                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Breach notification costs**    | Legal review, drafting notices, mailing/emailing every affected individual, credit-monitoring offers | A misconfigured Neon RLS policy or leaked API key exposes the `customers` table across all tenants. FWB must notify **every merchant's end-customers** (names, emails, phones, addresses) across every affected storefront — this is a multi-thousand-row incident even for one mid-size merchant, and FWB is multi-tenant so one breach can touch dozens of merchants' customer lists at once. |
| **Forensic investigation**       | Incident-response firm to determine scope, root cause, whether data actually left the environment    | Required before FWB can even tell merchants what to say to _their_ customers. Forensic firms bill $200–$500+/hr; a multi-day investigation easily runs $15k–$50k+ out of pocket without insurance.                                                                                                                                                                                              |
| **Data restoration**             | Rebuilding/recovering data corrupted or destroyed in an incident                                     | Applies even though FWB has daily encrypted backups + PITR — restoration coverage pays for the _labor and tooling_ to execute a large-scale restore, not just the backup's existence.                                                                                                                                                                                                           |
| **Business interruption**        | Lost revenue while systems are down                                                                  | FWB is the storefront host for every merchant on the platform. An outage caused by a cyber incident (ransomware, DDoS-driven downtime) stops **every merchant's sales simultaneously** — this is the multiplier that makes FWB's BI exposure larger than a single-tenant SaaS of similar size.                                                                                                  |
| **Cyber extortion / ransomware** | Ransom negotiation + payment (where legal) + related costs                                           | Even with strong controls, a compromised CI/CD credential or a third-party dependency (npm supply-chain attack) could lead to a ransomware event against the Neon DB or R2 buckets.                                                                                                                                                                                                             |

### Third-party coverage → FWB scenario

| Coverage                                               | What it pays for                                                                                                                                                                                         | Concrete FWB scenario                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Network, data & privacy liability**                  | Defense + settlement when a merchant or end-customer sues over a data incident                                                                                                                           | A merchant's storefront customer sues after their address/phone was exposed and used for a scam — FWB is the processor/host and can be named as a defendant even if the merchant is the "controller."                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Regulatory fines & defense costs (where insurable)** | Legal defense against a CITRA (Kuwait Data Privacy Protection Regulation; see also the Electronic Transactions Law No. 20/2014) investigation, or a GDPR regulator if any EU-resident data is implicated | FWB implements CITRA-style breach-notification timelines (24–72h to the regulator, per [CITRA DPPR](https://www.citra.gov.kw/sites/en/LegalReferences/Data_Privacy_Protection_Regulation.pdf)) plus GDPR-style erase/export endpoints for any EU exposure. Regulatory defense coverage pays the legal spend of responding to a CITRA inquiry even if no fine is ultimately levied. Note: many jurisdictions (including parts of the EU) bar insurers from indemnifying the _fine itself_ on public-policy grounds even where defense costs are covered — **confirm insurability of Kuwait/CITRA fines specifically with the broker**, this is jurisdiction-specific. |
| **PCI-DSS assessments / penalties**                    | Fines and forensic-assessment costs if a PCI event occurs                                                                                                                                                | FWB does **not** store cardholder data — MyFatoorah/Tap/Hesabe/UPayments handle card entry via their own hosted payment pages, so FWB's PCI scope is SAQ-A-equivalent (lowest tier). This coverage still matters as a backstop, and — importantly — **stating "hosted-page only, no cardholder data storage" up front is what keeps this line item cheap**; make sure whoever fills the application says exactly that.                                                                                                                                                                                                                                               |
| **Media/multimedia liability**                         | Claims over content displayed on hosted storefronts (defamation, IP infringement in merchant-uploaded content)                                                                                           | Merchants upload their own product images/copy to storefronts FWB hosts; a claim over infringing content on a hosted site could name FWB as the platform operator.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

**Bottom line:** FWB's risk profile is dominated by (a) multi-tenant blast radius — one incident can touch
many merchants' customer bases at once, and (b) business-interruption exposure across every hosted
storefront simultaneously. Both point toward buying **higher** first-party/BI limits relative to a
single-tenant SaaS of comparable revenue, not lower.

---

## 3. Recommended coverage limits

**Recommended target: $500,000–$1,000,000 aggregate limit**, with sub-limits reviewed for breach
notification and business interruption specifically (multi-tenant exposure argues for not skimping there).

### Why not the audit's originally-cited $50k–$1M / $200–600/yr range

The original audit finding cited a rough "$200–600/yr for $50k–$1M cover" benchmark. Current (2025–2026)
market research does not support the low end of that price range for a real-world small-SaaS policy:

- **MoneyGeek's 2026 report**: small businesses pay ~$83/month (~$999/yr) _on average_ for a **$1M
  aggregate** limit — but this "average" blends very-low-risk businesses (no PII, no payment flow) with
  higher-risk ones. ([MoneyGeek, Average Cyber Insurance Cost 2026](https://www.moneygeek.com/insurance/business/cyber/cost/))
- **More SaaS/data-handling-specific estimates put a robust $1M policy at $1,200–$3,500/yr**, and cite
  $1,500–$2,500/yr as typical for a small business in 2026. ([various small-business cyber cost guides,
  2026](https://www.christensengroup.com/article/small-business-cyber-insurance-costs))
- **SaaS-specific pricing** (bundled with other lines) runs closer to **$153/month (~$1,836/yr)** per one
  2026 SaaS-insurance cost source. ([Insuranceopedia, SaaS Company Business Insurance Cost
  2026](https://www.insuranceopedia.com/business-insurance/saas-company-insurance-cost))
- **Kuwait-specific**: a Kuwait cyber-insurance market report cites **premiums in the KWD 1,500–5,000
  (~$5,000–$16,500/yr) range** for Kuwait businesses generally. ([Ken Research, Kuwait Cyber Insurance
  Market](https://www.kenresearch.com/kuwait-cyber-insurance-market)) — this figure is a market-wide
  estimate, not tuned to a small SaaS with FWB's strong control posture (see §4), and Kuwait capacity is
  thin enough that pricing may not follow international benchmarks cleanly. **Flag this gap explicitly to
  brokers and ask them to explain the delta** — a well-controlled small SaaS should underwrite better than
  the market median, but Kuwait's limited local capacity may keep local-carrier pricing elevated
  regardless of controls.

**Revised recommendation:** budget **$1,500–$4,000/yr** as the realistic range for $500k–$1M of cover,
not $200–600/yr — treat the audit's original figure as a floor-case international benchmark, not a
Kuwait-market-adjusted number. Get 2–3 real quotes before locking a budget line.

**Why $500k–$1M and not less:** FWB's multi-tenant blast radius (§2) means a single incident's
notification cost alone (legal + mailing + credit monitoring, multiplied across every affected merchant's
customer list) can exceed $100k–$250k before forensics, BI, or any liability claim is even counted. A
$50k limit — the audit's original floor — would be exhausted by notification costs alone in a
multi-merchant breach scenario. $500k is a realistic minimum; $1M gives headroom as merchant count grows.

---

## 4. Risk profile — copy-pasteable underwriting questionnaire

Broker/underwriter applications ask a near-identical set of questions. Below is FWB's profile,
pre-filled where known. **Copy this section directly into any broker intake form or email.**

```
ENTITY
- Legal name: [ForceAI-KW — confirm exact registered entity name/CR number before submitting]
- Jurisdiction of incorporation: Kuwait
- Business description: Multi-tenant SaaS ecommerce platform (Force Website Builder / FWB) hosting
  storefronts for Kuwait/GCC merchants, plus a WhatsApp bulk-messaging product (WBS, WhatsApp Bulk
  Sender). Managed-agency model — no self-serve signup; merchants are onboarded and supported directly.
- Team size: Small (effectively solo founder + AI-assisted development). [confirm headcount for the app]
- Annual revenue: [TO FILL — required by every underwriter; drives premium calc directly]
- Number of merchant tenants live: [TO FILL]
- Number of end-customer records held (across all merchants): [TO FILL — estimate total PII rows:
  customers + orders + addresses across all storefronts]

DATA HANDLED
- Personal data types: names, emails, phone numbers, shipping addresses, billing addresses, order
  history, browsing/behavioral analytics
- Payment data: METADATA ONLY. No cardholder data (PAN, CVV, expiry) is stored, transmitted, or
  processed by FWB — all card entry happens on hosted payment pages operated by the PSPs (MyFatoorah,
  Tap, Hesabe, UPayments). FWB's PCI-DSS scope is the lowest tier (SAQ-A-equivalent) as a result.
- Special-category / sensitive data: none collected by design (no health, biometric, or financial
  account data beyond order/payment metadata).
- Analytics: PostHog, EU-hosted, IP address collection disabled at the config level.

JURISDICTION & REGULATORY EXPOSURE
- Primary: Kuwait — CITRA Data Privacy Protection Regulation (the operative Kuwait data-protection
  framework; see also the Electronic Transactions Law No. 20/2014). Breach notification to CITRA required within
  24–72 hours of discovery depending on current regulation text — confirm current SLA with counsel.
- Secondary: other GCC jurisdictions where merchants operate storefronts.
- EU exposure: possible, if any storefront serves EU-resident customers. FWB has implemented GDPR-style
  data-subject rights (erase + export endpoints) as a proactive control, independent of confirmed EU
  regulatory jurisdiction.

SUB-PROCESSORS / VENDORS (for supply-chain risk disclosure)
- Database: Neon (Postgres, encryption at rest + in transit, row-level security capable)
- Compute/hosting: Cloudflare Workers (web/admin/orders), Railway (API)
- Transactional email: Resend
- Product analytics: PostHog (EU-hosted)
- Error monitoring: Sentry
- Payment processing (hosted pages, no card data touches FWB): MyFatoorah, Tap, Hesabe, UPayments
- Background jobs / async: Inngest
- Push notifications: OneSignal
- Uptime monitoring: UptimeRobot

SECURITY CONTROLS (underwriters price these — list prominently, they reduce premium)
- Dependency security: npm audit clean at ZERO vulnerabilities across all severities (critical/high/
  medium/low) in production, enforced as a CI gate on every merge — not a point-in-time claim.
- Authentication: algorithm-pinned JWT auth (prevents alg-confusion attacks) with rotating refresh
  tokens and reuse detection (a stolen/replayed refresh token is detected and the session family revoked).
- Session security: httpOnly + SameSite cookies (mitigates XSS-based token theft and CSRF).
- Database isolation: row-level security (RLS)-capable multi-tenant database architecture — tenant data
  isolation enforced at the DB layer, not only in application code.
- Error monitoring: Sentry, real-time, in production.
- Backup & disaster recovery: daily encrypted database backups + point-in-time recovery (PITR).
- CI/CD security gates: automated secret scanning (gitleaks + trufflehog) and dependency audit run on
  every pull request — blocks merge on any finding.
- Rate limiting: enforced on API surfaces.
- CSRF protection: enforced.
- Encryption: at rest (Neon-managed) and in transit (TLS) throughout.
- MFA: [TO CONFIRM — state whether admin/staff accounts (Neon, Cloudflare, Railway, GitHub org) enforce
  MFA; if not yet enforced everywhere, note it as an in-progress control — underwriters ask this
  explicitly and reward "yes" answers with better pricing]

INCIDENT HISTORY
- Known breaches or cyber incidents to date: none known. [CONFIRM — state explicitly to broker; a clean
  history materially improves quotes and its absence must be verifiable, not assumed]
- Prior claims: none.

BUSINESS CONTINUITY
- RTO/RPO: [TO FILL — state target recovery time/point objectives if formalized; PITR gives strong RPO
  by default, worth quantifying for the application]
- Tested restore: [confirm whether backup restores have been drilled/tested, not just configured —
  underwriters increasingly ask this directly]
```

---

## 5. Carrier / broker shortlist

Kuwait's cyber-insurance capacity is genuinely thin — this is a market where a broker relationship does
more work than a self-serve online quote. Treat the list below as **starting points to call, not
confirmed appetite.**

| Carrier / broker                                                               | Type                                            | Kuwait/MENA fit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Next step                                                                                                                                                                   |
| ------------------------------------------------------------------------------ | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Gulf Insurance Group (GIG) — Kuwait parent (gulfinsgroup.com / gig.com.kw)** | Regional insurer, Kuwait-listed (Boursa Kuwait) | GIG is repeatedly named as a leading participant in the **Kuwait** cyber insurance market itself, alongside Kuwait Insurance Company, Al Ahli Takaful, and Warba Insurance ([Ken Research](https://www.kenresearch.com/kuwait-cyber-insurance-market)). Note: GIG's branded "GIG Gulf" cyber-insurance product page ([giggulf.ae](https://www.giggulf.ae/en/business/products/cyber-insurance)) explicitly lists UAE/Bahrain/Oman/Qatar and does **not** mention Kuwait — that product may be a different underwriting entity than the Kuwait-domestic GIG. **Confirm with broker which GIG entity underwrites Kuwait-domiciled risk.** | Contact gig.com.kw directly (Kuwait entity) and ask specifically for their Kuwait-domestic cyber product, not the GIG Gulf (UAE-regional) one.                              |
| **Warba Insurance & Reinsurance Company (warba.insure)**                       | Kuwait insurer                                  | Named as a Kuwait cyber-insurance market participant per the same Ken Research market report, but no dedicated cyber product page was found in this research pass. **Confirm product exists and get specifics from the company directly.**                                                                                                                                                                                                                                                                                                                                                                                              | Contact warba.insure and ask if they underwrite standalone cyber liability for a SaaS company (not just as an endorsement to a general liability policy).                   |
| **Kuwait Insurance Company / Al Ahli Takaful**                                 | Kuwait insurers                                 | Both named as Kuwait cyber-insurance market participants in the same market report. Not independently verified beyond that mention.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Confirm product existence + SaaS appetite directly.                                                                                                                         |
| **Aon (Middle East, Kuwait office)**                                           | Global broker                                   | Aon has a confirmed **Kuwait office** as part of its Middle East network (aon.com/kuwait), and runs a dedicated global Cyber Resilience practice. A broker (vs. a carrier) is often the fastest route in a thin local market — Aon can shop FWB's risk across both Kuwait-domestic and international (Lloyd's-backed) markets in one submission.                                                                                                                                                                                                                                                                                        | Contact the Kuwait office directly; ask them to run FWB's profile (§4) against both local Kuwait carriers and their Lloyd's/international cyber facilities.                 |
| **Marsh**                                                                      | Global broker                                   | Marsh's regional strength in the search results centers on a confirmed **UAE** office; a Kuwait-specific office was not confirmed in this research pass. Marsh is still worth a call — regional brokers commonly service Kuwait clients out of the UAE or Bahrain hub even without a standalone Kuwait branch. **Confirm Kuwait coverage capability directly.**                                                                                                                                                                                                                                                                         | Contact Marsh's UAE/regional office and ask whether they service Kuwait-domiciled clients.                                                                                  |
| **Lloyd's of London (via a broker, not directly)**                             | Global specialty market                         | Lloyd's is the largest global cyber-insurance capacity pool (77+ syndicates writing cyber per lloyds.com) and MENA risks are commonly placed into Lloyd's through a broker with delegated authority or open-market submission — this is the standard route when local-market capacity is thin, which Kuwait's is. **Not directly accessible — always placed through a broker (Aon/Marsh/a Lloyd's coverholder), never bought direct.**                                                                                                                                                                                                  | Ask Aon or Marsh (above) to include a Lloyd's market submission alongside the local-carrier quotes.                                                                         |
| **Coalition, At-Bay, Cowbell (US-focused MGAs)**                               | US/Canada-native "active insurance" MGAs        | These specifically target SaaS/tech companies and are the go-to names in most US startup cyber-insurance writeups, but all confirmed evidence in this research points to **US/Canada-only appetite** — Coalition's own materials describe coverage "in all 50 states... and CAD $20M... across Canada" with no MENA/Kuwait mention found. **Do not treat these as accessible without a US or UK-incorporated affiliate entity — confirm directly if ForceAI ever stands up a US/UK entity, otherwise deprioritize.**                                                                                                                    | Low priority unless/until a US or UK legal entity exists. If pursued, ask directly: "do you write standalone cyber for a Kuwait-domiciled parent with no US/UK subsidiary?" |
| **Liberty Specialty Markets (MENA)**                                           | International insurer, MENA-present             | Surfaced in research as offering a MENA-branded cyber-insurance product page (libertyspecialtymarkets.com/mena-en). Not independently verified for Kuwait-specific appetite in this pass.                                                                                                                                                                                                                                                                                                                                                                                                                                               | Worth a broker-routed inquiry alongside the Lloyd's submission.                                                                                                             |

**Overall read:** the fastest real path is **broker-led, not carrier-direct** — engage Aon's Kuwait
office (confirmed local presence) and ask them to run one submission across (a) Kuwait-domestic carriers
(GIG, Warba, Kuwait Insurance Co., Al Ahli Takaful) and (b) the Lloyd's/international market in parallel.
That single submission should surface real, bindable quotes faster than calling each Kuwait carrier
individually and faster than chasing US-only MGAs that likely won't write the risk at all.

---

## 6. Action checklist

- [ ] **Gather the two hard numbers underwriters always ask for first**: (1) annual revenue (or a
      realistic current run-rate if pre-revenue-reporting), (2) total end-customer PII records held
      across all merchant tenants (rough order-of-magnitude estimate is fine to start).
- [ ] **Confirm MFA enforcement status** on admin/staff accounts across Neon, Cloudflare, Railway, and
      the GitHub org — this is asked on nearly every cyber application and materially affects pricing.
      If not fully enforced, either enable it before applying or be ready to state a remediation timeline.
- [ ] **Confirm "no known incidents" is actually true** — check Sentry history, any past security
      findings, and the incident log (if one exists) before stating "none known" to an underwriter;
      misstating incident history can void a policy later.
- [ ] **Pick 2–3 contacts to request quotes from**, in this order: 1. Aon Kuwait office (broker — runs local + Lloyd's submission in parallel) 2. Gulf Insurance Group Kuwait entity (gig.com.kw) direct 3. Warba Insurance direct, or Marsh's UAE/regional office as a third broker opinion
- [ ] **Send each contact §4 (the risk profile) verbatim** — it is written to be pasted directly into an
      application or intake email, and leads with the security-controls list because that list is what
      earns better pricing; underwriters specifically look for MFA, encryption at rest/in transit, CI
      security gates, and tested backups, and FWB can truthfully claim all but MFA-completeness and
      tested-restore-drills (both flagged TO CONFIRM above — resolve those two before submitting for the
      best possible quote).
- [ ] **Target coverage**: $500k–$1M aggregate limit (§3), with attention to the breach-notification and
      business-interruption sub-limits given FWB's multi-tenant blast-radius exposure.
- [ ] **Budget**: plan for $1,500–$4,000/yr realistic range pending actual quotes — do not budget the
      audit's original $200–600/yr figure, current market data doesn't support it (§3).
- [ ] **Renewal cadence**: cyber policies are annual: calendar a renewal review 60 days before expiry,
      and re-run this brief's risk profile (§4) each renewal since revenue, record counts, and controls
      will have changed.
- [ ] **When a quote comes back**, sanity-check the sub-limits against §2's scenario table — a policy
      with a low breach-notification sub-limit relative to the aggregate limit is a red flag given FWB's
      multi-tenant exposure; ask the broker to explain any sub-limit that looks thin.

---

## Sources

- [Ken Research — Kuwait Cyber Insurance Market 2019–2030](https://www.kenresearch.com/kuwait-cyber-insurance-market) — Kuwait market sizing, named local carriers, premium range estimate
- [CITRA — Data Privacy Protection Regulation (PDF)](https://www.citra.gov.kw/sites/en/LegalReferences/Data_Privacy_Protection_Regulation.pdf) — Kuwait data-protection regulation text
- [GIG Gulf — Cyber Insurance product page](https://www.giggulf.ae/en/business/products/cyber-insurance) — coverage structure reference (UAE/Bahrain/Oman/Qatar entity)
- [Gulf Insurance Group K.S.C.P — Kuwait](https://www.gulfinsgroup.com/en/) / [gig.com.kw](https://www.gig.com.kw/en/) — Kuwait-domestic GIG entity
- [Aon — Kuwait / Middle East](https://www.aon.com/kuwait/default.jsp) and [Aon Cyber Insurance](https://www.aon.com/en/capabilities/cyber-resilience/cyber-insurance) — confirmed Kuwait broker presence
- [Marsh — Cyber Insurance](https://www.marsh.com/en/services/cyber-risk/expertise/cyber-insurance.html) and [Marsh UAE](https://www.marsh.com/en/locations/united-arab-emirates.html) — global broker, regional office reference
- [Coalition — Cyber Insurance](https://www.coalitioninc.com/cyber-insurance) — US/Canada coverage scope statement
- [Lloyd's — What We Insure: Cyber](https://www.lloyds.com/about-lloyds/our-market/what-we-insure/cyber) — global capacity pool, broker-routed placement model
- [Liberty Specialty Markets — Cyber Insurance (MENA)](https://www.libertyspecialtymarkets.com/mena-en/product/cyber-insurance) — MENA-branded product reference
- [MoneyGeek — Average Cyber Insurance Cost (2026 Report)](https://www.moneygeek.com/insurance/business/cyber/cost/) — US small-business pricing benchmark
- [Christensen Group — How Much Does Cyber Insurance Cost for a Small Business in 2026?](https://www.christensengroup.com/article/small-business-cyber-insurance-costs) — small-business pricing benchmark
- [Insuranceopedia — SaaS Company Business Insurance Cost 2026](https://www.insuranceopedia.com/business-insurance/saas-company-insurance-cost) — SaaS-specific pricing benchmark
