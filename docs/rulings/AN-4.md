# AN-4

> Section: 2026-09-30 — Analytics batch 1 (branch `fix/analytics-batch-1`, PR #2220)

**Ruling AN-4 — accepted residual: the Chromium bar-height layer of
`tests/unit/analytics-bar-charts-render.test.tsx` SKIPS in the CI unit job (no browser installed).**
The static layer (bar column carries `h-full justify-end`) still runs in CI; the pixel layer runs
locally with `CHROMIUM_PATH` and was mutation-proven there (measured 0px without `h-full`). Cost if
wrong: a future layout change that keeps both classes but still collapses the bars would pass CI.
