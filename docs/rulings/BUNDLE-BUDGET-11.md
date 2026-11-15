# BUNDLE-BUDGET-11

> Section: "Worker dry-run (api)" for the Smart Layer assistant (2026-11-14)

**Ruling BUNDLE-BUDGET-11 - the assistant adds 0.8 MB raw / 0.16 MB gzip to `worker.js` on purpose; the raw ceiling moves 8,300,000 -> 8,600,000 B and the gzip ceiling 2,200,000 -> 2,350,000 B; startup CPU is unchanged.**

Measured (local `wrangler deploy --dry-run`, 2026-11-14): main + the charter-guards branch 7,532,093 B raw / 2,069,583 B gzip; with the assistant 8,327,982 B raw / 2,231,887 B gzip. What it adds: the vendored engine (the whole input / plan / execute / output pipeline), `registry.generated.json` (the capability registry as the engine reads it, 81 KB) and `help-corpus.generated.json` (the help guides in chunks, 317 KB). The Worker cannot read files, so the corpus has to travel with it; the SDK `Client` was NOT the cost (replaced by a one-request transport, -12 KB).

Why not a separate module (the exceljs / pdf-lib route of BUNDLE-BUDGET-7 and -10): those are lazy code evaluated on rare requests. The registry and the corpus are read on every assistant turn and by the hourly index job, so they would be evaluated as often as they are loaded; moving them is a follow-up if the ceiling is reached again.

What did not change: startup CPU. The assistant imports nothing at module scope that runs work (the corpus and registry are parsed JSON, the engine is functions), and the route is only built when the Worker boots its router like every other route; the relative PR gate (PR vs main in the same job) stays the CPU check.

Cost if wrong: a looser ceiling lets the next feature walk further toward the 10 MB platform limit unnoticed; mitigated because the gate is still relative for startup and the new ceiling is 0.27 MB above the measured value.
