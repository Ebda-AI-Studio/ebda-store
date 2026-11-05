# FDN-TEXT-1

> Section: Ebda foundation adoption (2026-10-29)

**Ruling FDN-TEXT-1: the Store's Arabic fold (`normalizeArabicSearch`, now the foundation's `foldArabic`) is the canonical fold for every Ebda product.**
It has no NFKC and no locale lowercasing so the SQL twin `public.ebda_ar_norm` can match it byte for byte (SEARCH-2); `NORMALIZE_VECTORS` still pins both, and the same rows are the foundation's `vectors/arabic.json`. Ebda Chat keeps its own normaliser until its search step re-indexes. Cost if wrong: WhatsApp search stays slightly looser than the Store's (no folding of ئ ؤ ک) until that step ships.
