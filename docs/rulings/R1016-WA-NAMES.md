# R1016-WA-NAMES

> Section: 2026-10-16 — review of `fix/ahmad-decisions-1016` (R1016-\*)

Ruling R1016-WA-NAMES — WhatsApp canonical template names are `ebda_<purpose>_v<n>` (renamed from `force_*`, same versions and variables; the per-store Meta name stays `<store_slug>_<purpose>_v<n>`). A configured legacy `force_*` name keeps sending until the matching `ebda_*` row is APPROVED FOR THAT LANGUAGE for the store, then switches (`lib/wa-templates/legacy-names.ts`; tested incl. en approved / ar not). Switching early would send under a name Meta has not approved (WBS_TEMPLATE_MISSING). Cost if wrong: a store configured with a legacy name sends under it until re-submitted.
