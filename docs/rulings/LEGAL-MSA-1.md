# LEGAL-MSA-1

> Section: Launch-eve content consistency pass (2026-11-10, branch `fix/marketing-content-consistency`), from the ebda.app content audit (findings C1-C28)

Ruling LEGAL-MSA-1 - the legal pages (Terms, Privacy, Merchant Agreement, AUP, Legal notice, Data deletion, Refund, the three Ebda Chat documents) stay in formal Arabic (MSA) by design while every other page is Egyptian (audit C28). The repo rule already says "formal legal pages" (CLAUDE.md Copy) and `marketing-legal-ar-formal.test.ts` enforces it; rewriting binding text into colloquial Arabic would change legal content, which this launch pass must not do. Cost if wrong: legal pages read more distant than the rest of the site.
