# MKT-HTML-BUDGET-3

Ruling MKT-HTML-BUDGET-3 - raise the marketing HTML gzip budget for `/merchant-agreement` only (24 -> 24.5 KB) to the measured 24.1 KB. Evidence: `node scripts/ci/marketing-perf-budget.mjs` on current main plus CI job 127051750344 report 24.1 KB; the page grew with legal copy while main CI (affected jobs only) never measured it. The /contact JS overage is fixed at the cause (zod and the whole site copy no longer reach the form chunk), not by a budget change. Cost if wrong: ~0.5 KB more HTML on one legal page until the next ratchet.
