# SEARCH-T11-7

> Section: 2026-10-15 — Phase B1 Qamar (B1-\*)

Ruling SEARCH-T11-7 — accepted residual: a product whose doc makes the provider fail deterministically blocks that store's later batches (stale rows are picked newest-first, so the same batch repeats) until the product's text changes or someone looks at the P1 alert; other stores are unaffected. Evidence: the doc is a non-empty SQL-built string capped at ~3.5k chars, well inside bge-m3's 8192-token input, so no deterministic failure is known. Cost if wrong: one store's semantic index stops advancing; its search stays lexical-correct for every product and semantic for those already embedded.
