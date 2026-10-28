# SEARCH-14

> Section: 2026-10-16 — Search program, PR 1 (P0): SEARCH-\*

Ruling SEARCH-14 — Unlimited-OCR is evaluated offline only and never enters runtime. Evidence: it needs a CUDA GPU host (a second runtime and ops surface), and Gemini vision already runs on Inngest. Cost if wrong: if it clearly beats Gemini on long Arabic PDFs, a GPU path is a separate decision with its own plan.
