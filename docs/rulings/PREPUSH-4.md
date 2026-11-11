# PREPUSH-4

> Section: 2026-11-11 CI fast, parallel, never flaky

Ruling PREPUSH-4 - pre-push is light again (MAC-LIGHT-1): secret scan, action pins, prettier and the scanner set run unlocked-by-default; ONLY the vitest steps take `heavy-test.lock`, and `vitest related` is skipped with the message "CI runs it, sharded" when more than `PREPUSH_RELATED_MAX` (default 6) source files changed. Evidence: measured 2026-11-11, load average 17-24 on 10 cores and about 28 pushes queued for hours behind one lock that wrapped the whole gate. The cap counts changed source files, not resolved test files, because resolving the module graph costs about as much as running it (measured: `vitest list --changed` 34 s under load for one file). Cost if wrong: a wide change reaches CI without its local related run, so a failure shows on the PR instead of before the push; CI (sharded unit lane) remains the gate and zero checks is never green.
