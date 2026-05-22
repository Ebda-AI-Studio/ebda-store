# Force Store — Business Documentation

> Customer-facing + go-to-market documentation for Force Store / Force Website Builder. Generated 2026-05-22 from the comprehensive SaaS audit, the codebase feature registry, and verified competitive research.

---

## Documents in this folder

| #   | Document                                                       | Audience                                                  | Length       |
| --- | -------------------------------------------------------------- | --------------------------------------------------------- | ------------ |
| 1   | [01-overview.md](01-overview.md)                               | Everyone — start here                                     | ~1,200 words |
| 2   | [02-feature-catalog.md](02-feature-catalog.md)                 | Merchant prospect evaluating the product                  | ~3,200 words |
| 3   | [03-competitive-positioning.md](03-competitive-positioning.md) | Merchant comparing vs Shopify / Salla / Wix / WooCommerce | ~2,900 words |
| 4   | [04-pricing-tiers.md](04-pricing-tiers.md)                     | Internal — Ahmad sets billing flow + sales conversations  | ~4,100 words |
| 5   | [05-pitch-deck-outline.md](05-pitch-deck-outline.md)           | Sales / investor / acquirer pitch (12-slide outline)      | ~1,800 words |
| 6   | [06-faq.md](06-faq.md)                                         | Public-facing FAQ                                         | ~3,000 words |

**Total:** ~16,200 words. Reading time end-to-end: ~75 minutes.

---

## Reading order by audience

### Kuwait merchant evaluating Force Store

1. **01-overview** — 5-minute read, decide if Force Store fits
2. **06-faq** — answers to "do you support X?"
3. **02-feature-catalog** — deep dive on what's included
4. **03-competitive-positioning** — honest comparison vs whatever you're using today
5. **04-pricing-tiers** — pick a plan

### Investor / VC

1. **01-overview** — the 30-second pitch
2. **05-pitch-deck-outline** — the full 12-slide story
3. **03-competitive-positioning** — moat analysis
4. **04-pricing-tiers** — revenue model + unit economics
5. **Internal:** also read `docs/audits/2026-05-22-comprehensive-saas-audit.md` (SWOT + risk register + cost forecast)

### Strategic acquirer

1. **01-overview** — what you're potentially buying
2. **05-pitch-deck-outline** — slide 12 has the acquirer-specific ask + estimated range
3. **Internal:** `docs/audits/2026-05-22-comprehensive-saas-audit.md` — full due-diligence pack with P0/P1 risk register and acquisition checklist
4. **02-feature-catalog** — what features exist + what's coming
5. **03-competitive-positioning** — defensibility analysis

### Journalist / blogger writing about Force Store

1. **01-overview** — the pitch you can quote
2. **06-faq** — answers to common reader questions
3. **02-feature-catalog** — full feature inventory if you want to be exhaustive
4. **Contact:** [hello@forcemediakw.com](mailto:hello@forcemediakw.com) for interview / quotes / live demo

### Internal team / future hires

Read everything in order 1 → 6. Also pair with:

- `docs/audits/2026-05-22-comprehensive-saas-audit.md` (technical audit)
- `CLAUDE.md` (strategic positioning + 13 production-readiness rules)
- `docs/ROLLBACK.md` + `DEPLOYMENT.md` (operations)

---

## Document lifecycle

- **Versioning:** these docs are dated 2026-05-22. They will rot — review quarterly against the live product.
- **Update triggers:**
  - New feature ships → update `02-feature-catalog.md` + `04-pricing-tiers.md`
  - Competitor pricing changes → update `03-competitive-positioning.md`
  - New tier / pricing change → update all 6 docs (prices appear in multiple)
  - New tenant goes live → update slide 7 of `05-pitch-deck-outline.md`

- **Source of truth:** when these docs and the codebase disagree, the codebase is correct. Update the docs.

---

## What's NOT here

Intentionally excluded:

- **Internal technical detail** — see `CLAUDE.md` + `docs/audits/`
- **Sales scripts / call playbooks** — separate doc when sales motion is formalized
- **Engineering changelog** — separate doc when public changelog launches
- **API documentation** — public API is on the roadmap
- **Marketing collateral** (landing page copy, ad copy, email sequences) — separate doc when marketing motion is formalized
- **Partner / reseller program** — TBD as the platform grows

---

## Companion docs (technical)

If you came from the business side and want to peek under the hood:

- [`docs/audits/2026-05-22-comprehensive-saas-audit.md`](../audits/2026-05-22-comprehensive-saas-audit.md) — full SaaS due-diligence audit (security, performance, infrastructure, costs, SWOT, risk register)
- [`docs/audits/_slices/`](../audits/_slices/) — 6 per-domain audit deep-dives
- [`CLAUDE.md`](../../CLAUDE.md) — strategic positioning + 13 production-readiness rules (the internal compass)
- [`DEPLOYMENT.md`](../../DEPLOYMENT.md) — production topology
- [`docs/ROLLBACK.md`](../ROLLBACK.md) — incident response

---

## Questions about this documentation

- **Spotted a contradiction?** Open an issue or email [hello@forcemediakw.com](mailto:hello@forcemediakw.com)
- **Want to translate to Arabic?** AR versions are on the roadmap — the primary product is already bilingual, but these docs are EN-only for now
- **Want to use this material in marketing?** Yes, the prose is yours to adapt. Cite Force Store / Force AI as source.
