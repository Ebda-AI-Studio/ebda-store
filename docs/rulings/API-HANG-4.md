# API-HANG-4

**Ruling API-HANG-4 - in `api-hang-concurrency` "200 concurrent cold reads", a read that waited on an AuthState deadline is bounded by the designed fallback (1.5 s + 2.5 s per deadline, capped at the storefront's 8 s cut-off), not by the 2 s healthy-path bound.**

Evidence. On #741 (docs-only: plan files moved) the test read p50 3089 / p95 3128 / max 3129 ms against 2000 on the Mac runner (host load ~10 on 10 cores, 19 test files sharing one workerd). All 200 reads finished within 40 ms of each other, which is a shared wait, not CPU contention (that spreads p50 well below max). The job log shows `AuthStateTimeoutError ... after 2500 ms (do-cachegen-getx5)` during the batch: the AuthState DO was starved, every generation read hit the deadline, and the reads answered through the designed fallback (the fill skips its write, API-HANG-1) at ~2.5 s + ~0.6 s.

Change.

- `withAuthStateDeadline` pushes `auth-state-timeout:<label>` into the request's DEV_STATS io ops (`x-dev-io-ops`). The tally has no `ops` in production, so this is a no-op there.
- `getCached` single-flight: the leader records the deadlines its fill hit and a follower copies them onto its own request. Measured: with every generation read stalled, only 10 of 200 reads carried the marker (5 stores x 2 paths = 10 fill leaders); the other 190 waited on a leader's timed-out fill unmarked. `/public/stores` waits on two fills in series, so it pays 2 deadlines (~5.2 s).
- The test bounds each read by `budgetFor(deadlines)`: 0 -> 2000 ms (unchanged), n -> min(8000, 1500 + 2500 n). A read without a marker keeps the strict bound, so a missing marker only makes the test stricter. The STUCK test asserts every forced-timeout read carries the marker (the instrument's negative control).

Mutations (all on local workerd): marker removed -> STUCK test fails; follower propagation removed + all reads stalled -> test fails; 2100 ms injected delay (below the 2500 ms deadline) -> test fails (the strict bound still catches a slow healthy path); all reads stalled with the fix -> passes.

Cost if wrong: a regression that makes AuthState calls time out on a HEALTHY runner would pass this test (it would read as the designed fallback). Production still logs every deadline (`authStateTimeout: true`), and the 150 ms relative test (API-HANG-3) still pins the serial round-trip count.
