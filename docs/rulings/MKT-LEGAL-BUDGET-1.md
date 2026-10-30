# MKT-LEGAL-BUDGET-1

Ruling MKT-LEGAL-BUDGET-1 - raise the HTML gzip budget of the Arabic `/terms` (21.5 KB) and `/merchant-agreement` (21.2 KB) pages from the 20.5 KB default. The formal legal text on main measures 21.3 KB and 20.9 KB (CI run 40882406866, reproduced on a fresh build of origin/main), so the `Worker dry-run (marketing)` gate failed on every PR; no code changed, the legal copy simply grew past the default. The English pages stay under the default. Cost if wrong: two long legal pages may grow another 1 KB gzip unnoticed before the gate trips again.
