# BUILDER-IMAGE-1

> Section: 2026-10-07 — Visual builder Phase 1 (branch `feat/builder-phase1`, BUILDER-\*)

Ruling BUILDER-IMAGE-1 — image settings are checked for scheme (http(s) or relative), not for the R2 host the file plan proposed. Evidence: the layout PUT never enforced a host, so stored layouts may carry other hosts (not measured against production); an R2-only rule would make their next Save fail. Cost if wrong: a merchant can hot-link an external image (no script execution: `javascript:`/`data:` are rejected).
