# GCC Data Protection Law — FWB Reference

> **Reference, not legal advice. Reviewed by: [pending — qualified GCC counsel].**
> **Last researched: 2026-09-22.**
>
> This document was produced to replace an unverifiable citation — "Kuwait Personal Data
> Protection Law 13/2023" — that appeared in ~37 files / ~82 places across this repo. Web
> research found **no such Kuwaiti statute**. Per owner instruction, Kuwait's primary
> citation in this document and downstream contracts is **Kuwait Electronic Transactions
> Law No. 20 of 2014**, supplemented by CITRA's Data Privacy Protection Regulation.
> Every claim below carries a source URL and a primary/secondary label. Anything that
> could not be confirmed against a primary source is marked **[unverified]** — never
> guessed, never filled from memory. Sources materially disagree with each other on
> several points (resolution numbers, scope, exact deadlines); where they do, both
> readings are reported rather than one being silently chosen.

## How to read this

- **Primary** = official gazette / regulator-hosted text. **Secondary** = law-firm client
  alert, compliance-tech vendor summary, or aggregator. Most GCC data-protection detail
  below is secondary-sourced — several regulator sites (CITRA, PDPA Bahrain, Al Meezan
  Qatar) returned 403s or redirects to automated fetches during this research pass, which
  is disclosed per-country rather than silently worked around.
- **[unverified]** means: could not be confirmed against a primary source after real
  search effort. It is not a hedge-word sprinkled everywhere — it marks a specific,
  named gap in what was confirmed.
- FWB architecture facts used throughout: primary DB = Neon Postgres, `aws-eu-central-1`
  (Frankfurt, Germany, EU), project `fwb-eu`; encrypted daily backups to local storage +
  Cloudflare R2 (30-day retention, region unconfirmed — R2 is Cloudflare's global object
  store); API on Railway; storefront/admin/orders on Cloudflare Workers. FWB is the
  **processor**; each GCC merchant is the **controller** of its shoppers' data.

---

## 1. Kuwait

**Owner-mandated primary citation: Electronic Transactions Law No. 20 of 2014.**
Confirmed real, official Arabic/English text hosted by KDIPA:
[ETL 20/2014 (KDIPA PDF)](https://kdipa.gov.kw/wp-content/uploads/2022/08/%D9%82%D8%A7%D9%86%D9%88%D9%86-%D8%A7%D9%84%D9%85%D8%B9%D8%A7%D9%85%D9%84%D8%A7%D8%AA-%D8%A7%D9%84%D8%A7%D9%84%D9%83%D8%AA%D8%B1%D9%88%D9%86%D9%8A%D8%A9-20-%D9%84%D8%B3%D9%86%D8%A9-2014-%D9%85%D8%AA%D8%B1%D8%AC%D9%85-%D8%A8%D8%A7%D9%84%D9%84%D8%BA%D8%A9-%D8%A7%D9%84%D8%A7%D9%86%D8%AC%D9%84%D9%8A%D8%B2%D9%8A%D8%A9.pdf).

**Honest scope assessment:** ETL 20/2014 is fundamentally an e-signature / e-transaction-
validity law, not a data-protection statute. Its personal-data content is thin and
indirect — **Chapter Six** restricts government authorities, companies and NGOs from
accessing/disclosing/publishing "personal data" without the data owner's consent, and
requires purpose-specification, accuracy, and safeguards. Source (secondary, dated
2015-12-11): [Kuwait ETL — introduction of a concept akin to data privacy — Global Compliance News](https://www.globalcompliancenews.com/2015/12/11/kuwait-law-regarding-electronic-transactions-in-force-introduction-of-a-concept-akin-to-data-privacy/).
General data-subject rights (access, modify/delete) are attributed by one secondary
practice guide to **Articles 33 and 36**: [Chambers & Partners — Data Protection & Privacy 2026, Kuwait](https://practiceguides.chambers.com/practice-guides/data-protection-privacy-2026/kuwait).
A separate single-source aggregated snippet cites **Article 32** as prohibiting disclosure
of health/financial/personal-status information without consent or a court order —
**[unverified: seen in only one aggregated snippet, not cross-checked against the
official Arabic PDF or a second law-firm source]**. Executive regulations are cited by one
secondary aggregator as **Ministerial/Cabinet Decision No. 48 of 2014** —
**[unverified: single-source, article/decision number not independently confirmed]**.

**Conclusion for citations going forward:** cite **ETL 20/2014, Chapter Six (Arts. 33 & 36
for general data-subject rights; Art. 32 disclosure restriction — [unverified])** as the
general/non-sectoral legal basis, per owner instruction — but do not overstate its
coverage; it is thin next to a purpose-built data-protection law.

**CITRA Data Privacy Protection Regulation (DPPR) — the operative sector regime, WITH A
CONFIRMED VERSION HISTORY, not a single disputed number:**

- **2021 version: Resolution No. 42 of 2021**, "Data Privacy Protection Regulation,"
  effective 4 Apr 2021. Primary: [CITRA — Resolution No. 42/2021 (official PDF)](https://www.citra.gov.kw/sites/en/LegalReferences/Resolution-No-42-On-Data-Privacy-Protection-Regulation.pdf).
  Applied broadly to all "Service Providers" providing Communication/IT services in
  Kuwait (public + private). Secondary summary: [Kuwait DPPR — Securiti](https://securiti.ai/kuwait-data-privacy-protection-regulation/).
- **2024 version: Resolution/Administrative Decision No. 26 of 2024**, replacing
  Resolution 42/2021 (effective ~19 Feb 2024 per one source). Sources: [Access Partnership](https://accesspartnership.com/opinion/access-alert-kuwaiti-regulator-introduces-new-data-protection-regulation/),
  [DLA Piper — Kuwait country guide](https://www.dlapiperdataprotection.com/?t=law&c=KW),
  [Signzy — Kuwait PDPL 2024/CITRA](https://www.signzy.com/regulation-glossary/personal-data-protection-law-2024-CITRA).
  Al Tamimi & Co also covers this instrument but the fetch was blocked by a redirect —
  title/existence only confirmed via search, content **[unverified]**.
- **Genuine, reported (not silently resolved) disagreement — scope:** Access Partnership
  frames the 2024 scope as "all CITRA-licensed service providers, irrespective of data
  processing locations" (broad); a separate synthesis suggests the 2024 revision
  **narrowed** scope to telecom-licensed CITRA licensees only, dropping the 2021 broader
  "any CIT service provider" framing. **This directly matters for FWB**: is a Kuwaiti
  e-commerce merchant even a CITRA licensee? **[unverified: which scope reading is
  authoritative]** — flag for counsel.
- **Genuine, reported disagreement — breach-notification window:** 2021-era regulation
  (Securiti) = **72 hours** to CITRA. 2024-era regulation (DLA Piper + Access Partnership)
  = **24 hours** to CITRA. Most likely explanation is the 2024 replacement tightened the
  window, but this is **not independently confirmed against the 2024 primary text**
  (CITRA's own PDF for Resolution/Decision 26/2024 could not be located in this pass) —
  **[unverified against primary text]**.
- Data-owner (subject) breach notification is also required "if the breach affects their
  personal data," with a carve-out under the 2021 text if the provider had implemented
  "appropriate technical and regulatory measures" — not confirmed whether this carve-out
  survives in the 2024 replacement.

**Data-subject rights:** access, rectification/correction, erasure/destruction/
anonymization (on consent withdrawal or when data no longer needed), consent withdrawal.
Source: Securiti (above). **No statutory response deadline was found in any source** —
report this as a genuine absence, not an omission.

**Cross-border transfer — the Frankfurt question:** ETL 20/2014 restricts transfer "in an
illegal manner without the consent of the concerned person" (consent-based, not
localisation-based — DLA Piper). CITRA DPPR (2021 text): transfer outside Kuwait is
**permitted** provided the service provider notifies data owners of the intent to
transfer and follows CITRA-recommended measures — **no hard adequacy list, no blanket
localisation requirement** found for general commercial/e-commerce data. DLA Piper's
current guide (reflecting the 2024 regime) reiterates a disclosure/consent-based
approach (name the receiving countries), with no SCC-style safeguard mandated in the
text found.

**Verdict — Kuwait merchant, shopper data in Frankfurt:** _Appears lawful in principle_,
provided (a) shoppers are informed of / consent to the transfer (privacy-notice
disclosure naming Germany/Frankfurt as the processing location), and (b) CITRA-
recommended security measures are followed. **Moderate confidence, secondary-sourced
only** — no primary CITRA text on cross-border mechanics was directly fetched. This
reading is further complicated by the unresolved scope question above: if the 2024 DPPR
narrows to telecom licensees only, a pure e-commerce merchant may fall back to the
thinner ETL 20/2014 consent-based rule alone (which reaches the same practical
conclusion — consent/disclosure is sufficient, no adequacy gate).

**Processor obligations / DPA content:** no statutory list of mandatory
controller-processor contract clauses found in either ETL 20/2014 or CITRA DPPR
summaries — CITRA DPPR imposes direct provider-level duties rather than prescribing
inter-business contract terms. Treat this as a genuine gap FWB fills using prudent
(GDPR-modelled) DPA terms, not a specific Kuwaiti statutory checklist.

**Registration / DPO:** no general controller/processor registration requirement found.
No mandatory _standing_ DPO appointment found — DLA Piper's guide states providers need
only supply CITRA with the **contact details of an appointed data protection officer at
the time of breach reporting**, implying an ad hoc, breach-triggered role rather than a
statutory standing DPO mandate.

**Retention vs. erasure conflict:** a secondary aggregator (Wafeq/PwC-adjacent search
synthesis) cites **minimum 10-year retention of corporate accounting records**
(invoices, contracts, supporting documentation) — **[unverified: could not fetch a
primary Kuwait Ministry of Commerce/Companies Law citation; no specific article number
found]**. Separately, DLA Piper's guide notes CITRA DPPR requires deletion
post-contract-termination "with exceptions for security, judicial rulings, and financial
claims," consistent with (but not identical to) a financial-records retention carve-out.
**This is materially different from the "Kuwait MOF ≥5y" figure already hardcoded in
FWB's codebase** (`apps/api/src/lib/inngest/functions/data-retention.ts`) — see §9 Gaps.

---

## 2. Saudi Arabia

**Law:** Personal Data Protection Law (PDPL), Royal Decree M/19 (17 Sep 2021) approving
Council of Ministers Resolution No. 98 (14 Sep 2021), Official Gazette 24 Sep 2021.
Amended by Royal Decree M/148 (Council of Ministers approval 21 Mar 2023). Per Art. 43,
in force 720 days after gazette publication = **14 September 2023**, plus a further
one-year transition ending **14 September 2024** — now fully enforceable. Regulator:
**SDAIA** (Saudi Data & AI Authority; NDMO subdivision is the likely eventual supervisory
authority). Sources (secondary, convergent): [Morgan Lewis, Sep 2024](https://www.morganlewis.com/pubs/2024/09/saudi-arabia-personal-data-protection-law-transition-period-ends-september-14),
[CMS Law — one-year anniversary](https://cms.law/en/are/legal-updates/one-year-anniversary-saudi-personal-data-protection-law).
Primary-adjacent: SDAIA's PDPL guide portal, `dgp.sdaia.gov.sa`.

**Implementing Regulations:** published by SDAIA **7 September 2023**, one week before
the law's in-force date. Source (secondary): Lexology summary; regulations.ai entry
`saudi-arabia-2023-09-pdpl-implementing-regulations`.

**Data-subject rights & deadline:** access, correction, erasure, portability/objection,
consent withdrawal. **Response deadline: 30 days**, extendable by a further **30 days**
for unusual/complex requests or multiple requests from the same subject. Well-corroborated
across multiple secondary compliance guides (dpo-consulting.com, complyan.com) but
**[unverified against the primary regulation's article number]**.

**Breach notification:** to **SDAIA within 72 hours** of the controller becoming aware,
**no materiality threshold** (the controller cannot self-assess and withhold). Data
subjects notified "without undue delay" where the breach risks their rights/interests.
Source (secondary): [complyan.com — SDAIA PDPL breach framework](https://complyan.com/sdaia-pdpl-series-part-1-personal-data-breach-incidents-the-three-stage-response-framework/).

**Cross-border transfer — CRITICAL for Frankfurt hosting:** SDAIA issued the
**Regulation on Personal Data Transfer Outside the Kingdom** in August 2024, in force
**1 September 2024**, superseding the PDPL's original stricter default (case-by-case
approval/adequacy). Current rule: transfer outside KSA is permitted if the controller
uses an **approved safeguard** — SDAIA Standard Contractual Clauses, approved Binding
Common Rules (intra-group), or a Certificate of Accreditation — **plus** a documented
transfer/adequacy-style risk assessment of the recipient country (mandatory for
large-scale/sensitive/continuous transfers). Explicit consent is _one_ legal basis, not
the only route. **No blanket data-localisation mandate under the PDPL itself.** Sources
(secondary, convergent): [King & Spalding](https://www.kslaw.com/news-and-insights/international-personal-data-transfers-under-saudi-arabias-data-protection-law),
[Securiti.ai — transfer regulation summary](https://securiti.ai/regulation-on-personal-data-transfer-outside-the-kingdom/),
[ITIF, Jun 2025](https://itif.org/publications/2025/06/09/saudi-arabia-cross-border-data-transfer-regulation).

**Verdict — Saudi merchant, shopper data in Frankfurt:** workable, not prohibited — FWB
(as processor) needs to offer SDAIA-form SCCs or an equivalent approved safeguard in the
DPA, a documented transfer risk/impact assessment, and disclosure in the merchant's
privacy notice. **[unverified]:** could not confirm from a primary SDAIA-hosted text
whether the _specific transfer mechanism_ also needs notification/registration with
SDAIA, versus safeguard-adoption alone being sufficient.

**Processor obligations / DPA content:** Implementing Regulations require processor
engagement by **written contract** specifying processing scope, purpose, obligations,
security measures, and sub-processor consent; processor must assist the controller with
rights requests and breach notice. Source (secondary): [Akin Gump](https://www.akingump.com/en/insights/alerts/kingdom-of-saudi-arabias-new-personal-data-protection-law-and-implementing-regulations).

**Registration / DPO / RoPA:** DPO appointment required for controllers/processors
handling PDPL-scoped data (amendments propose formal SDAIA DPO registration). **Record
of Processing Activities (RoPA)** must be kept during processing **and for 5 years after**
processing ends. SDAIA's National Data Governance Platform (NDGP) registration is
mandatory for public entities, sensitive-data processors, or entities whose _primary
business is data processing_ — **this falls on the controller (the merchant)**, not on
FWB, unless FWB itself meets one of those triggers (worth a standing counsel check, given
FWB aggregates data across many merchants). Sources (secondary): [Herbert Smith Freehills Kramer](https://www.hsfkramer.com/insights/2023-11/saudi-arabias-personal-data-protection-law-what-you-need-to-know),
Baker McKenzie Global Data & Cyber Handbook.

**Retention conflict — SEPARATE FROM PDPL, and the single most architecturally
important finding in this document:** Saudi **Law of Commercial Books** requires
accounting records retained **≥10 years**, in Arabic, stored (physically or digitally)
**within the Kingdom**. Separately, **ZATCA e-invoicing** rules require invoices/tax
records retained **≥6 years** from the end of the relevant tax period (some sources cite
up to 11 years for certain invoice categories — figures disagree; **[unverified: exact
6-vs-11-year split by invoice category not confirmed against primary ZATCA text]**);
**e-invoices must be archived on servers located WITHIN Saudi Arabia.** This is a real
**data-localisation constraint on Saudi order/invoice records specifically**, independent
of the PDPL's (workable) cross-border regime — it implies Saudi merchants' invoice-level
financial data may need in-Kingdom storage/backup **regardless of where the general
commerce database sits**. Sources (secondary): [Basware compliance map — Saudi Arabia](https://www.basware.com/en/compliance-map/saudi-arabia),
[Tasc Outsourcing](https://tascoutsourcing.sa/en/insights/bookkeeping-in-saudi-arabia-top-5-challenges-businesses-face-and-how-to-overcome-them),
Qoyod, Wafeq.

---

## 3. United Arab Emirates

### 3a. Federal PDPL

**Law:** Federal Decree-Law No. 45 of 2021 on the Protection of Personal Data. In force
since **2 January 2022** (secondary: [Clyde & Co, Nov 2021](https://www.clydeco.com/en/insights/2021/11/uae-issues-landmark-personal-data-protection-law)).
Regulator: **UAE Data Office** — per [DLA Piper (checked Jan 2025)](https://www.dlapiperdataprotection.com/countries/uae-general/law.html)
it was **not yet fully empowered** as of that check. Executive Regulations: **Cabinet
Decision No. 33 of 2024** — multiple secondary sources agree it exists and entered into
force in 2024, but **[unverified]: exact effective date and primary Cabinet Decision text
not directly reached**.

**Data-subject rights & deadline:** access, rectification, erasure ("right to be
forgotten"), restriction, portability, objection. Response window commonly cited as
**30 days** across multiple secondary firms — **[unverified against primary article
text]**.

**Breach notification:** to the UAE Data Office **within 72 hours** of becoming aware,
when the breach is likely to result in risk to individuals; data-subject notification
required for high-risk breaches. **[unverified: exact article number/trigger wording not
independently confirmed against primary text]**. Source (secondary): [DTS Solution](https://www.dts-solution.com/uae-pdpl-deadline-2027-is-your-organisation-ready/).

**Cross-border transfer:** PDPL permits transfer outside the UAE subject to conditions
(adequate protection in the destination, or contractual/other safeguards, or consent) —
[US Dept of Commerce Market Intelligence](https://www.trade.gov/market-intelligence/united-arab-emirates-allows-cross-border-data-flows-personal-data)
confirms conditional cross-border flows are allowed, but **[unverified]: no primary
confirmation of a federal "adequacy list" analogous to DIFC/ADGM, nor of Germany/EU's
status on any such list.**

**Processor obligations:** PDPL requires controller-processor contracts; obligations
largely mirror the GDPR structure (secondary, [Securiti](https://securiti.ai/uae-personal-data-protection-law/))
— exact contractual content requirements not independently itemized from primary text.

**DPO:** Article 10 triggers — (a) high-risk processing from new/large-scale technology,
(b) systematic/comprehensive assessment of sensitive data incl. profiling, (c)
large-volume sensitive-data processing. DPO may be external/non-UAE-resident; the UAE
Data Office must be notified of the DPO's contact details. Source (secondary explainer,
not primary gazette text): [uaepdpl.com — Article 10](https://uaepdpl.com/article-10/).

**Retention conflict:** UAE VAT records (FTA) require **≥5-year retention** from the end
of the relevant tax period for invoices/VAT returns/ledgers; capital-asset records **10
years**; real-estate records **15 years**; may extend up to 4 more years under
audit/dispute. Records must remain **accessible in the UAE** — a localisation-adjacent
point for tax records specifically, separate from PDPL. Sources (secondary): [ASC Global](https://www.ascglobal.ae/insight-details/fta-audit-ready-bookkeeping-5-year-record-retention-2025-compliance-essentials),
[ClearTax UAE](https://www.cleartax.com/ae/uae-vat-record-keeping).

### 3b. DIFC (Dubai International Financial Centre — free zone)

**Law:** DIFC Data Protection Law No. 5 of 2020, amended 2022 and **2025**; consolidated
Data Protection Regulations, current version in force **1 September 2023** (secondary:
[PrivacyEngine](https://www.privacyengine.io/blog/dubai-difc-data-protection-law/)).
Regulator: **DIFC Commissioner of Data Protection** ([primary/official DIFC page](https://www.difc.com/business/registrars-and-commissioners/commissioner-of-data-protection)).

**Cross-border transfer — CRITICAL FINDING:** Article 26 of the DP Law — transfer
outside DIFC permitted only to a jurisdiction the Commissioner deems adequate, OR under
appropriate safeguards (DIFC Standard Contractual Clauses, Art. 27(2)(c)), OR
derogations. The **adequate-jurisdictions list is Appendix 3 of the DIFC Data Protection
Regulations 2020**, and per convergent secondary sources it **includes all EU/EEA member
states (therefore Germany), UK, Switzerland, Japan, South Korea, and California (added
Aug 2023)**. The primary DIFC page confirming the list's existence:
[difc.ae — Adequate Data Protection Regimes](https://www.difc.ae/business/operating/data-protection/adequate-data-protection-regimes/)
— **this was read via search snippet only, not a direct full-page fetch; recommend
fetching it directly before treating "Germany is listed" as fully confirmed.** The 2025
amendment (per PrivacyEngine) added a requirement for a **documented adequacy
assessment** before relying on adequacy status even for a listed jurisdiction — so a DIFC
merchant needs a written assessment on file, not mere reliance on the list.

**Verdict — DIFC merchant, shopper data in Frankfurt:** highly likely lawful via the
Art. 26 adequacy route (Germany/EU-27 is an EEA member state, and DIFC's list is
described as including all EEA states) — but requires a documented adequacy assessment
per the 2025 amendment, and the list itself is **[unverified by direct primary fetch]**.

**Data-subject rights / breach notification / DPO / registration for DIFC:**
**[unverified]** — not independently retrieved this pass. DIFC's regime is generally
described as GDPR-structured (secondary consensus) but exact deadlines were not
confirmed.

### 3c. ADGM (Abu Dhabi Global Market — free zone)

**Law:** ADGM Data Protection Regulations 2021 (DPR 2021). Regulator: **ADGM Office of
Data Protection**. Primary: [ADGM — Office of Data Protection, jurisdictions page](https://www.adgm.com/operating-in-adgm/office-of-data-protection/jurisdictions)
(read via search snippet, not direct fetch); [ADGM Rulebook s.41](https://en.adgm.thomsonreuters.com/rulebook/41-transfers-basis-adequacy-decision)
(primary rulebook text, confirms the adequacy mechanism exists).

**Cross-border transfer — CRITICAL FINDING:** Section 41, DPR 2021 — transfer outside
ADGM permitted where the Commissioner has made an adequacy decision for the receiving
jurisdiction/sector/international organisation. ADGM is reported (secondary) to
recognise **43 adequate jurisdictions, described as "identical to the GDPR/DIFC adequacy
list, plus DIFC itself."** Since EU/EEA member states (Germany included) sit inside the
EU Commission's own adequacy framework, and ADGM/DIFC extend adequate status to all EEA
states as a bloc, **an ADGM merchant's data hosted in Frankfurt is very likely to a
recognised-adequate jurisdiction** — **[unverified: recommend confirming the current
list directly at the ADGM URL above before relying on this in a signed document]**.
Absent adequacy, transfer is permitted via BCRs or SCCs (secondary: [abspartners.ae](https://abspartners.ae/cross-border-data-transfers-from-adgm-dpr-2021/)).

**Data-subject rights / breach notification / DPO / registration for ADGM:**
**[unverified]** — not independently retrieved this pass; DPR 2021's structure is
generally described as GDPR-aligned by design intent (secondary consensus, no article
citation confirmed).

### UAE summary verdict for Frankfurt hosting

- **Federal PDPL:** transfer permitted under conditions; **[unverified]** whether
  Germany/EU sits on any confirmed federal adequacy list — likely needs a
  contractual/SCC-equivalent safeguard or consent as the operative basis absent a
  confirmed federal adequacy mechanism.
- **DIFC:** Germany/EU highly likely on the Art. 26/Appendix 3 adequate-jurisdictions
  list — transfer lawful, but as of the 2025 amendment requires a **documented**
  adequacy assessment on file, not mere reliance.
- **ADGM:** Germany/EU highly likely adequate via the EU-Commission-mirrored 43-
  jurisdiction list — transfer lawful, subject to confirming the current list directly.
- All three readings rest partly on secondary/snippet-sourced confirmation — recommend
  a direct primary-page fetch of the DIFC/ADGM adequacy-list URLs above before this
  enters a signed contract as an asserted fact.

---

## 4. Qatar

**Law:** Law No. 13 of 2016 Concerning Privacy and Protection of Personal Data
("PDPPL"), Official Gazette 29 Dec 2016, in force since 2017. Sources (secondary):
[Securiti.ai — Qatar PDPL](https://securiti.ai/qatar-personal-data-protection-law/),
[DataGuidance — Qatar](https://www.dataguidance.com/jurisdictions/qatar-state). Regulator
has changed hands: originally the Compliance and Data Protection (CDP) department under
the Ministry of Transport and Communications (MOTC); CDP now sits inside the **National
Cyber Security Agency (NCSA)'s National Cyber Governance and Assurance Affairs (NCGAA)**
division, sometimes called the National Data Privacy Office (NDPO). **Qatar Financial
Centre (QFC) is a separate free zone with its own Data Protection Regulations** — out of
scope here; mainland Law 13/2016 governs a typical FWB merchant.

**Note on Kuwait's mis-citation:** this is the real "Law No. 13" in the GCC — closest in
number/vintage to the fabricated "Kuwait Law 13/2023" and almost certainly the source of
the repo's copy-paste error.

Executive Regulations / PDPPL Guidelines exist (strengthening consent, breach-
notification, transfer, and technical-control requirements) but **[unverified: exact
instrument number/date not confirmed]** — referenced by [Wattlecorp](https://www.wattlecorp.com/qatar-data-protection-law-with-pdpl/).

**Data-subject rights & deadline:** access (a copy of data, on payment of a service
charge), correction/rectification, erasure (if processing is unnecessary/unfair/purpose
has lapsed), objection, consent withdrawal. Response deadline: the PDPPL text itself does
not fix a number of days; NCGAA **guidance** points to **30 calendar days**, mirroring
QFC's own 30-day regime (extendable +30 for complex requests). **Treat 30 days as
guidance, not confirmed statutory text** — [PrivacyEngine](https://www.privacyengine.io/blog/qatar-data-protection-law-vs-gdpr/).

**Breach notification:** notify NCGAA and affected individuals when the breach causes
"serious damage" to personal data/privacy. PDPPL **Guidelines** (not the base law itself)
set a **72-hour** window from detection — **flag as guidance-level, not confirmed
statutory text**. Source (secondary): Securiti.ai.

**Cross-border transfer:** Article 15 of Law 13/2016 — **no blanket restriction** on
international data flow; NCSA/NCGAA may restrict a _specific_ transfer only if it would
breach the PDPPL or expose an individual to serious harm. **No adequacy list, no
mandated SCC/contract mechanism, no consent-required-for-transfer rule in the statute**
— compliance is judged against PDPPL's general processing/security principles, not a
named transfer instrument. **[unverified]: no primary-source (Al Meezan) confirmation of
Article 15's exact wording** — the fetch attempt 307-redirected and could not be
retrieved directly; this rests on the Securiti.ai secondary summary.

**Verdict — Qatari merchant, shopper data in Frankfurt:** _appears lawful as written_ —
no adequacy/SCC gate to clear — provided FWB applies PDPPL's general security/processing
safeguards and the transfer doesn't itself cause "serious harm." **Comparatively the most
permissive regime in this document** next to GDPR-style adequacy-list systems.

**Processor obligations:** PDPPL **Guidelines** (not the base law) mandate a written
controller-processor contract specifying nature/purpose/duration of processing, security
measures, and data-subject rights; processor must notify the controller of breaches or
emerging risks.

**Registration / DPO / RoPA:** controllers must maintain Records of Processing
Activities (RoPA) including marketing activities; DPIAs recommended before new
processing (documented justification if skipped). **No explicit general DPO-appointment
mandate surfaced — [unverified either way].** Obligation as framed falls on the
controller (the merchant), consistent with FWB's processor role.

**Retention vs. erasure conflict:** Commercial Law No. 27 of 2006 (Trading Regulation
Law) governs merchant bookkeeping; multiple secondary sources state accounting
books/registers/documents must be retained in Qatar for **10 years**. A separate source
states tax invoices must be kept **at least 5 years** per the General Tax Authority
(GTA). **These two figures are not reconciled in the sources found** —
**[unverified: which figure controls, and the exact GTA regulation article]**. Practical
read for FWB: treat 10 years as the governing figure for commercial books, pending
primary confirmation.

---

## 5. Bahrain

**Law:** Personal Data Protection Law, **Law No. 30 of 2018**, enacted 12 Jul 2018, in
force since **1 August 2019**. Regulator: **Personal Data Protection Authority (PDPA)**,
under the Ministry of Justice, Islamic Affairs and Waqf. Official text (primary, both
403'd on automated fetch during this pass — existence/URL confirmed via search only):
[pdp.gov.bh (regulations PDF)](https://www.pdp.gov.bh/en/assets/pdf/regulations.pdf),
[mola.gov.bh — Ministry legal-affairs portal](https://www.mola.gov.bh/MediaManager/Media/Documents/Laws/Batch3/L3018.pdf).
Key implementing instrument: **Resolution No. 42 of 2022** (Adequacy List / cross-border
transfer rules) — secondary confirmation: [Trowers & Hamlins](https://www.trowers.com/insights/2022/may/bahrain-enhances-its-data-protection-regime),
[Clyde & Co](https://www.clydeco.com/en/insights/2022/04/bahrain-issues-new-privacy-guidelines).

**Data-subject rights & deadline:** access, correction, erasure, objection/consent
withdrawal (**portability not confirmed as a distinct named right — [unverified]**).
**Response deadline: 10 working days** from receipt, free of charge, per **Article 14**
— secondary source: [Recording Law](https://www.recordinglaw.com/world-laws/world-data-privacy-laws/bahrain-data-privacy-laws/).
**[unverified against primary text — the 403 blocked direct article confirmation; treat
"10 working days" as secondary-sourced only]**. This is the **shortest confirmed
data-subject response deadline found across all six countries.**

**Breach notification:** controller notifies **PDPA within 72 hours** of discovery via
PDPA's online portal (bilingual Arabic/English templates), unless unlikely to affect
individuals' rights; high-risk breaches also require notifying affected data subjects.
Late notice needs a documented justification. Sources (secondary): [ASAR Legal](https://www.asarlegal.com/heightened-cyber-threats-legal-and-reporting-obligations-in-bahrain/),
[bizfaq](https://bizfaq.keylinkcorp.co/what-are-the-data-breach-reporting-requirements-in-bahrain-2025-update/).
Penalties: PDPA can order suspension/withdrawal of authorization, daily penalties up to
BD 2,000, fines up to BD 20,000.

**Cross-border transfer — CRITICAL FINDING:** Articles 12–15 PDPL + **Resolution No. 42
of 2022** created an **"Adequacy List" of ~83 countries/territories** that may receive
Bahraini personal data **without prior PDPA authorization**. The list is reported
(secondary, two independent convergent sources) to explicitly include **all EU member
states (therefore Germany), EEA states, UK, US, all other GCC states, and more**.
Sources: [riskassociates.com](https://riskassociates.com/no-show/navigating-international-data-transfers-bahrain-pdpl/),
[zubipartners.com](https://zubipartners.com/2024/02/06/navigating-data-transfer/).

**Verdict — Bahraini merchant, shopper data in Frankfurt: the cleanest "yes" in this
document.** Germany/the EU is on the adequacy list — transfer is lawful **without
further safeguards**, subject to general PDPL processing/consent requirements.
**[unverified]: could not reach PDPA's own published Adequacy List PDF directly (403) to
confirm Germany/EU by primary source** — rests on two convergent secondary summaries.

**Processor obligations:** PDPL requires a **written agreement** between the controller
("Data Manager") and any third-party processor; the processor must process data strictly
per the controller's instructions and is bound by the same confidentiality/security
duties as controllers. Sources (secondary): [Trowers & Hamlins](https://www.trowers.com/insights/2019/december/pdpl---bahrains-data-protection-regime),
[Securiti.ai](https://securiti.ai/overview-of-bahrain-personal-data-protection-law-pdpl/).
**[unverified]: exact article number for DPA-content requirements not confirmed from
primary text.**

**Registration / DPO:** Bahrain's PDPL term is **"Data Protection Guardian" (DPG)** —
functionally equivalent to a DPO. **[unverified]: could not confirm whether DPG
appointment / PDPA registration is controller-only or also applies to processors, nor
the trigger threshold that makes DPG appointment mandatory.**

**Retention vs. erasure conflict:** Bahrain's National Bureau of Revenue (NBR) extended
**VAT record retention to 10 years** (from 5), effective 28 Feb 2024 — covers tax
invoices, accounting books, balance sheet/P&L, fixed-asset and inventory records.
Real-estate-related tax records: **15 years**. Source (secondary): [Global Compliance News / Baker McKenzie](https://www.globalcompliancenews.com/2024/04/20/https-insightplus-bakermckenzie-com-bm-tax-bahrain-the-national-bureau-of-revenue-nbr-extends-record-retention-period-to-10-years_04042024/).
This 10-year VAT retention would override/coexist with any PDPL erasure right for
order/invoice records — erasure should mean anonymization of PII fields, not deletion of
the underlying transaction record, within that 10-year window. **[unverified]: general
(non-VAT) Commercial Law retention period not found.**

---

## 6. Oman

**Law:** Personal Data Protection Law, **Royal Decree No. 6/2022**, Official Gazette
Issue No. 1429. Primary: [MTCIT — PDPL promulgation (PDF)](https://prod.mtcit.gov.om/ITAPortal//Data/English/DocLibrary/2024115132533256/PROMULGATING%20THE%20PERSONAL%20DATA%20PROTECTION%20LAW.pdf),
[decree.om](https://decree.om/2022/rd20220006/). Regulator: **Ministry of Transport,
Communications and Information Technology (MTCIT)** ([mtcit.gov.om](https://mtcit.gov.om/sectors/governance/personal)).

**In-force date — genuine disagreement, reported not resolved:** initial effect **13 Feb
2023**; Executive Regulations published **4 Feb 2024** giving a **1-year grace period to
5 Feb 2025** ([Addleshaw Goddard](https://www.addleshawgoddard.com/en/insights/insights-briefings/2024/data-protection/executive-regulations-oman-personal-data-protection-law/)).
Separate 2026-dated sources describe the law "entering full enforcement" as of **5 Feb
2026** ([CMS Law](https://cms.law/en/omn/legal-updates/oman-personal-data-protection-law-entering-the-enforcement-phase),
[SearchInform](https://searchinform.com/blog/2026/2/18/oman-pdpl-2026-full-enforcement-dlp-compliance/)).
**[unverified]: exact reconciliation of "grace period to 5 Feb 2025" vs. "full
enforcement 5 Feb 2026" — secondary sources disagree by a year; no primary MTCIT
enforcement notice found confirming which is current.**

**Data-subject rights & deadline:** access, rectification/correction, erasure (one
stated exception: data held for national archiving), portability, consent withdrawal
([Securiti](https://securiti.ai/oman-personal-data-protection-law-pdpl/)). Response
deadline: **45 days** — [decree.om blog](https://blog.decree.om/2026/data-subject-rights-under-omans-pdpl-where-the-law-falls-short-and-how-to-fix-it)
(secondary; article number not confirmed). **This is the longest confirmed
data-subject-response deadline found across all six countries.**

**Breach notification:** **72 hours** to notify both MTCIT and affected data subjects
(where the breach poses serious harm/high risk), tied to **Article 19**; penalty
15,000–20,000 OMR for non-compliance. Sources (secondary): [ITLawCo](https://itlawco.com/omans-personal-data-protection-law-pdpl/),
[Trowers & Hamlins](https://www.trowers.com/insights/2024/february/omans-data-protection-law---new-regulations).
**[unverified against primary gazette text.]**

**Cross-border transfer:** no blanket localisation rule found. Executive Regulations
**Art. 37**: explicit data-subject **consent is sufficient** for transfer outside Oman,
provided it doesn't prejudice national security/higher interests; **no prior MTCIT
approval required** in the general case. **Art. 38**: controller must ensure the
overseas processor provides protection no less than PDPL/Regulations level. Penalty for
transfers causing harm: 100,000–500,000 OMR. Source (secondary): Addleshaw Goddard /
Lexology summary of the Executive Regulations.

**Verdict — Omani merchant, shopper data in Frankfurt:** _plausibly lawful_ — Germany/EU
is a recognised high-protection jurisdiction — but FWB needs (a) explicit consent
language covering the transfer in the shopper-facing consent flow, and (b) a
controller-processor contract documenting EU-grade protection is in place.
**[unverified]: whether MTCIT has published a formal "adequate countries" list or
transfer-mechanism form (SCCs-equivalent) — not found.**

**Processor obligations:** a written contract between controller and processor is
required, but the Executive Regulations **do not prescribe mandatory contract clauses**
(unlike GDPR Art. 28). Processors must also maintain RoPA, obtain written/exclusive
consent for marketing use of PD, and maintain a data-protection policy/confidentiality
guarantee. Further controller/processor/auditor regulations were "expected to be issued
in due course" per Addleshaw Goddard — **[unverified: whether those additional
regulations have since been issued].**

**Registration / DPO:** PDPL **Art. 20** requires controllers to appoint a DPO per
criteria in the Executive Regulations (qualified, aware of PDPL/Regulations/the
organisation's own data-protection practices). RoPA obligation applies generally to both
controllers and processors. **[unverified]: whether there is a separate MTCIT
registration/notification regime distinct from DPO appointment.**

**Retention vs. erasure conflict:** Oman Law of Commerce (**Royal Decree No. 55/90**):
**Art. 28** requires retaining correspondence, telegrams, invoices and essential trade
documents; **Art. 31** requires keeping day books and inventory books for **10 years**.
Sources (secondary, corroborated across two): [Oman Law Blog / Curtis](https://omanlawblog.curtis.com/2012/04/legal-requirements-for-document.html),
[Lexology](https://www.lexology.com/library/detail.aspx?g=9dfd30c4-3158-4af4-a075-cd62dab5c012).
**[unverified]: Oman VAT-specific tax-invoice retention period not independently
confirmed — a GCC-wide fin-tax reference surfaced but its Oman-specific figure was not
verified in this pass; do not cite a number from it without re-checking.**

---

## 7. Requirements matrix

Columns: the six countries, then **FWB implementation today** (grepped from the
codebase, not guessed) and **Gap** classification — **CODE** (FWB must build it),
**CONTRACT** (DPA/SCC/terms), **HOSTING** (region/localisation), **CONTROLLER** (the
merchant's own duty, not FWB's).

| Obligation                                    | Kuwait                                               | Saudi Arabia                                                               | UAE (Federal / DIFC / ADGM)                                                   | Qatar                                                     | Bahrain                                                               | Oman                                                                 | FWB implementation today                                                                                                                                                                                                                                                                                                            | Gap                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Access**                                    | Yes, no statutory deadline found                     | 30d (+30 extendable)                                                       | ~30d (federal, unverified)                                                    | ~30d (NCGAA guidance, not statutory)                      | 10 working days (Art. 14, unverified)                                 | 45d                                                                  | `GET /auth/me/export` — synchronous, self-service, returns full JSON bundle in the HTTP response (`apps/api/src/routes/auth.routes.ts:711-732`, `AuthService.exportAccount`)                                                                                                                                                        | None for self-service — already faster than every deadline above. **CODE gap for non-self-service**: no admin-mediated path if a shopper emails the merchant instead of logging in                                                                                                                                                                               |
| **Erasure**                                   | Yes ("destruction/anonymization")                    | Yes                                                                        | Yes (federal + DIFC + ADGM)                                                   | Yes                                                       | Yes                                                                   | Yes (exception: national-archive data)                               | `POST /auth/me/erase` — irreversible anonymization in one DB transaction, preserves order/financial rows minus PII (`apps/api/src/routes/auth.routes.ts:672-706`, `AuthService.eraseAccount`, `apps/api/src/services/auth.service.ts:1314-1423`); monthly cron catches soft-deleted stragglers (`data-retention.ts:94-160`)         | **CODE gap**: Shopper-initiated only (`role !== 'customer'` rejected) — no Merchant/support-agent-initiated erasure path exists (confirmed: no such route in `customers.routes.ts` or elsewhere)                                                                                                                                                                 |
| **Correction / rectification**                | Arts. 33/36 (unverified)                             | Yes                                                                        | Yes                                                                           | Yes                                                       | Yes                                                                   | Yes                                                                  | Partial: `PUT /auth/me` updates firstName/lastName/phone only; `address.routes.ts` has full address CRUD (`PUT /:id`)                                                                                                                                                                                                               | No unified "correction request" tracking, but functional self-service exists for the fields most likely to need correction — **low-priority CODE gap**                                                                                                                                                                                                           |
| **Portability**                               | Not distinctly named                                 | Yes                                                                        | Yes (federal + DIFC + ADGM)                                                   | Not distinctly confirmed                                  | Not confirmed as distinct right (unverified)                          | Yes                                                                  | Same `GET /auth/me/export` endpoint serves this                                                                                                                                                                                                                                                                                     | None — already implemented                                                                                                                                                                                                                                                                                                                                       |
| **Objection / consent withdrawal**            | Yes                                                  | Yes                                                                        | Yes                                                                           | Yes                                                       | Yes                                                                   | Yes                                                                  | `CookiePreferencesModal` + footer link let a shopper change marketing consent any time; `CookieConsentBanner` gives equal-weight Accept/Reject (no dark pattern) (`apps/web/src/contexts/ConsentContext.tsx`, `CookieConsentBanner.tsx`)                                                                                            | None for marketing cookies. No broader "object to any processing" mechanism beyond cookie category — **minor CODE gap**, low materiality given FWB's processing is mostly contract-necessary                                                                                                                                                                     |
| **Consent records (demonstrable)**            | Implied by CITRA DPPR disclosure duty                | Implied (GDPR-modelled Implementing Regs)                                  | Implied                                                                       | Implied                                                   | Implied                                                               | Implied                                                              | **Client-side cookie only** (`force-cookie-consent`, 1yr max-age, `v:1`, `ts` timestamp) — **no server-side persisted record** of the decision (already flagged internally: `docs/audits/2026-05-28-auth-access-audit.md` P1-E, line 166/224 — "cookie consent mutations are browser-only, compliance reconstruction unverifiable") | **CODE gap** — build a server-side consent-event table (userId/sessionId, decision, version, timestamp, IP-hash) so consent is demonstrable to any regulator, not just inferable from a cookie that expires or gets cleared                                                                                                                                      |
| **Breach notification (to regulator)**        | 24h or 72h (disputed, unverified 2024 text)          | 72h, no materiality threshold                                              | ~72h (unverified)                                                             | 72h (guidance, not statutory)                             | 72h (Art., via PDPA portal)                                           | 72h (Art. 19)                                                        | **No code path exists.** `grep -rn breach apps/api/src` returns zero matches; `alert-webhooks.routes.ts`/`alerts.service.ts` is a Sentry→Telegram ops-alerting bridge only, not a regulator- or merchant-facing breach-notification mechanism                                                                                       | **CONTRACT gap** (commit to an SLA in the DPA — draft proposes 72h, see §9) + **CODE gap** (no incident-response tooling exists to notify merchants systematically when FWB detects a platform-wide incident)                                                                                                                                                    |
| **Cross-border transfer (data in Frankfurt)** | Workable via consent/disclosure (unverified primary) | Workable via SDAIA SCCs + risk assessment (confirmed mechanism)            | Federal: unverified adequacy; DIFC/ADGM: likely adequate (Germany/EU on list) | Workable, permissive regime, no adequacy gate             | **Cleanest yes** — Germany/EU on the Resolution 42/2022 Adequacy List | Workable via explicit consent + processor-protection contract clause | DB in `aws-eu-central-1` (Frankfurt); DPA draft §6 currently only names Neon/Resend/Cloudflare sub-processor locations, no per-country transfer-mechanism language                                                                                                                                                                  | **CONTRACT gap** — DPA needs a per-country transfer-basis clause (see §8); no CODE gap (architecture itself is workable everywhere except the Saudi ZATCA carve-out below)                                                                                                                                                                                       |
| **Retention minimum (orders/invoices)**       | ~10y (unverified, aggregator)                        | ≥10y commercial books / ≥6y ZATCA e-invoices (both unverified exact split) | ≥5y VAT / 10y capital assets / 15y real estate                                | ~10y commercial books vs. ~5y tax invoices (unreconciled) | 10y (VAT, confirmed 2024 NBR change) / 15y real estate-tax            | 10y (Commerce Law Art. 31)                                           | **Hardcoded 5 years, uniform for every merchant regardless of country**: `ORDER_ANONYMIZE_RETENTION_DAYS = 365 * 5` (`apps/api/src/lib/inngest/functions/data-retention.ts:37`), comment cites "Kuwait MOF ≥5y" only; `docs/RETENTION.md` "Future work" explicitly states **per-store retention overrides are not implemented**     | **CODE gap — the most material one in this document.** 5/6 countries' commercial/tax-retention figures researched here are 10 years (or a disputed 6–11y for Saudi ZATCA specifically); FWB's platform-wide 5-year anonymization window under-retains order PII for Bahraini, Omani, Qatari and Saudi merchants relative to their own commercial-law obligations |
| **Processor contract (DPA)**                  | No statutory clause list found                       | Written contract, content specified (Implementing Regs)                    | Written contract required (federal); DIFC SCCs available                      | Written contract required (Guidelines, not base law)      | Written agreement required by statute                                 | Written contract required, no mandated clause list                   | `docs/legal/DPA-DRAFT-2026-09-22.md` — draft exists, DRAFT PR #1850, Kuwait-only framing as of this task's start                                                                                                                                                                                                                    | **CONTRACT gap — in progress this session** (§8 below); being made GCC-wide                                                                                                                                                                                                                                                                                      |
| **Registration / DPO**                        | No standing DPO; breach-time contact only            | DPO required (controller); NDGP registration for certain entity types      | Federal Art. 10 triggers; DIFC/ADGM unverified                                | RoPA required; DPO not confirmed either way               | "Data Protection Guardian" — trigger/threshold unverified             | Art. 20 DPO required (controller)                                    | No FWB-side DPO appointed or documented; no per-merchant DPO guidance in the DPA                                                                                                                                                                                                                                                    | **CONTROLLER obligation** (falls on each merchant as controller) — DPA §5 should tell merchants this explicitly; **possible CONTROLLER-adjacent FWB obligation** under Saudi NDGP if FWB itself is judged "primary business is data processing" — flagged for counsel, not asserted                                                                              |

---

## 8. Strictest common denominator

The single set of behaviours that lets ONE FWB codebase + ONE DPA satisfy all six
countries, taking the strictest confirmed figure per obligation (and flagging where the
"strictest" figure is itself unverified, so the choice is precautionary rather than
asserted as legally mandated):

1. **Data-subject response deadline: self-service is already instant** (export/erase are
   synchronous HTTP endpoints) — this dimension is already solved for the dominant case.
   For any request that reaches FWB through a non-self-service channel (a Merchant asking
   FWB to act on a Shopper's behalf), target **10 working days** — matching Bahrain's
   confirmed (if unverified-against-primary) figure, the shortest found — which is
   comfortably inside every other country's window (30–45 days).
2. **Breach notification: FWB → Merchant within 24 hours** of confirmed detection
   (covers Kuwait's disputed-but-possible 24h 2024 CITRA figure as a precaution) so the
   Merchant then has the full runway to meet its own regulator's clock, all of which are
   72 hours or looser (Saudi/Oman/Bahrain/Qatar-guidance) once Kuwait's disputed 24h is
   already covered by FWB's own faster internal SLA. Requires new incident-response
   tooling (CODE gap above) — today nothing pages a merchant.
3. **Cross-border transfer: adopt SCCs (or an SDAIA-equivalent approved safeguard) as the
   DPA's standard transfer mechanism for every merchant, regardless of country.** This is
   the only country where transfer is NOT workable on consent/disclosure alone (Saudi
   requires an approved safeguard mechanism), so building to Saudi's bar satisfies every
   lighter regime as a superset (Kuwait/Qatar/Oman's consent-based rules, and Bahrain/
   DIFC/ADGM's adequacy routes, are all satisfied a fortiori by an SCC-backed contract).
   Pair this with a plain-language shopper-facing disclosure that data is processed and
   stored in Frankfurt, Germany (EU) — the common baseline needed at minimum for Kuwait's
   and Oman's consent-based regimes.
4. **Retention: anonymize order/invoice PII no earlier than 10 years from order date**,
   not the current 5 — this is the CODE change with the widest blast radius (Bahrain,
   Oman, Qatar, Saudi's commercial-books figure, and Kuwait's unverified aggregator
   figure all converge on 10 years; only the UAE's VAT-specific 5-year floor is shorter,
   and UAE's own capital-asset/real-estate figures already reach 10–15 years). Concretely:
   change `ORDER_ANONYMIZE_RETENTION_DAYS` in `apps/api/src/lib/inngest/functions/data-retention.ts`
   from `365 * 5` to `365 * 10`, and add the per-store/per-country override that
   `docs/RETENTION.md`'s "Future work" section already anticipates but never built.
5. **Consent: keep the existing granular, equal-weight accept/reject/customize UI**
   (already best-practice across every regime surveyed) and **add a server-side consent
   record** (userId/sessionId, decision, version, timestamp, IP-hash) so consent is
   demonstrable, not just inferable from a client cookie.
6. **Build the Merchant-initiated erasure path** already flagged as a known gap in the
   DPA draft — every country's processor-assistance obligation implies FWB must be able
   to fulfil a request that reaches it through a channel other than the Shopper's own
   login.
7. **Carve out Saudi Arabia's ZATCA e-invoice in-Kingdom archival requirement as a named
   exception**, not a silently-ignored edge case — the single-Frankfurt-region
   architecture is workable for every OTHER obligation in every OTHER country, but Saudi
   invoice-level financial records specifically may need an in-Kingdom archive copy
   regardless of where the general commerce database lives. This is a HOSTING-level
   decision, not something the retention/consent code changes above can absorb.

---

## 9. Notes on the "Kuwait MOF ≥5y" code comment vs. this document's findings

`apps/api/src/lib/inngest/functions/data-retention.ts` and `docs/RETENTION.md` both cite
**"Kuwait MOF (tax authority)... ≥5 years"** as the reason orders are retained (with PII
scrubbed) for 5 years before full anonymization. This session's Kuwait research did not
find a primary confirmation of that exact "5 years, MOF-specific" figure — it found a
different, also-unverified secondary figure of **10 years for general corporate
accounting records** (source: an aggregator, not the Ministry of Finance directly, and
not cross-checked against a specific statute article). These may not actually conflict
— a tax-invoice-specific retention period and a general-corporate-books retention period
can legitimately differ — but **neither figure has been confirmed against a primary
Kuwaiti source in this pass or, apparently, in the pass that originally produced the
code comment.** Recommend Ahmad confirm the correct Kuwait figure with a Kuwaiti
accountant/counsel before this document's §8 "10 years, strictest common denominator"
recommendation is implemented — if Kuwait's own real figure turns out to be shorter than
10 years, that doesn't change the recommendation (Bahrain/Oman/Qatar/Saudi still drive
the 10-year floor), but it does mean the code comment's specific "Kuwait MOF ≥5y" citation
should also carry a source URL going forward, not be stated as bare fact.

---

## 10. Sources — full list

All sources are cited inline above, per-country, with a primary/secondary label and the
date context available. Repeated here is only the meta-point: **every regulator's own
site that was attempted (CITRA Kuwait's 2024 text, PDPA Bahrain, Al Meezan Qatar) either
403'd or redirected automated fetches during this research pass on 2026-09-22.** This
document is therefore built almost entirely on secondary sources (law firms: DLA Piper,
Clyde & Co, Trowers & Hamlins, Baker McKenzie, Akin Gump, Morgan Lewis, CMS Law, King &
Spalding, Addleshaw Goddard, ASAR Legal, ITLawCo; compliance-tech vendors: Securiti.ai,
PrivacyEngine, Recording Law, ClearTax, Basware, ASC Global; government-adjacent:
US Dept of Commerce Market Intelligence). Everywhere a primary regulator PDF or page WAS
reached (Kuwait's ETL 20/2014 via KDIPA, CITRA's 2021 Resolution 42 PDF, Oman's MTCIT
promulgation PDF, DIFC's own Commissioner page, ADGM's Rulebook s.41), that is called out
explicitly in the relevant country section above. **A qualified GCC counsel review
should treat every secondary-only citation in this document as a starting point for
primary verification, not a finished legal conclusion.**
