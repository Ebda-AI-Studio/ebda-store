# SEARCH-10

> Section: 2026-10-16 — Search program, PR 1 (P0): SEARCH-\*

Ruling SEARCH-10 — Semantic search ships OFF and is turned on only when the eval bar holds: hybrid recall@10 ≥ 0.90, dialect and franco each ≥ 0.80, MRR ≥ 0.70, no msa/en regression > 0.02, and a dialect+franco lift ≥ 0.15 over lexical. Cost if wrong: a bar that is too strict leaves a working feature off; the eval output in PR 4 makes that visible.
