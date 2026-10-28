# SEARCH-T5-3

> Section: 2026-10-16 — Search program, PR 1 (P0): SEARCH-\*

Ruling SEARCH-T5-3 — the PII filter is broader than the brief's ratio rule: any `@`; any run of 8+ digits with separators (a phone in any script after normalisation, a 14-digit national id); `ord-`/`wa-` order numbers; UUIDs; links; 20+ character letter+digit tokens with at least 20% digits or hex. Accepted false positives, pinned in a unit `describe('accepted false positives')`: 8+ digit barcodes/SKUs, size lists such as `size 38 40 42 44`, year ranges such as `2024/2025`, and glued 20+ character model strings. `مقاس 42 43 44` (6 digits) is kept. Evidence: review probes. Cost if wrong: a few product-code searches are missing from insights (the log is lossy by design; admin search is unaffected).
