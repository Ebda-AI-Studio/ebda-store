# BUNDLE-BUDGET-12

> Section: "Worker dry-run (api)" for the Smart Layer assistant (2026-11-15)

**Ruling BUNDLE-BUDGET-12 - the help corpus leaves `worker.js` as its own Worker module; no ceiling moves (8,600,000 B raw / 2,350,000 B gzip stay).**

Measured (local dry-run): the assistant stack on top of main reached 8,912,291 B raw / 2,366,160 B gzip (over both ceilings). `help-corpus.generated.json` was the largest input (810 KB of `worker.js`). It is now `apps/api/src/cf/modules/help-corpus.mjs` (built by `apps/api/scripts/build-help-corpus.mjs`, uploaded by the existing `rules` glob), loaded on first use and cached per isolate (`helpCorpus()` in `smart-layer/help-index.ts`). Result: 8,102,539 B raw / 2,219,318 B gzip, startup CPU 121.8 ms (3 local runs; PRs gate relative to main). Behaviour is unchanged; `helpCorpus()` and `helpFigureSources()` became async.

This reverses the BUNDLE-BUDGET-11 note that moving the corpus was a follow-up: the ceiling was reached, so it moved. A missing module rejects loudly (cron logs it, the turn fails); it never yields an empty corpus.

Cost if wrong: a deploy that drops `cf/modules/help-corpus.mjs` fails assistant turns and the hourly index job until redeployed; the dry-run output lists the module, and the existing pdf-lib and exceljs modules use the same upload path.
