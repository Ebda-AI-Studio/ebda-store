# API-HANG-3

**Ruling API-HANG-3 - the `api-hang-concurrency` "production-like 150 ms" assertion becomes a relative bound; the 500 ms absolute p95 was runner speed, not a regression.**

Evidence. On #653 (a backup-chunking PR that touches nothing on the cold read path) the test read p50 534 / p95 557 ms against 500; on a laptop it reads ~348 ms. The same runner measures the Worker's startup at ~370 ms vs 115-194 ms locally, i.e. 2-3x slower CPU, which is the extra ~200 ms over 2-3 serial 150 ms round trips. The assertion exists to pin the NUMBER of serial AuthState round trips on a cold read (1 generation read, not three: the pre-API-HANG-1 code is +2 x 150 ms).

Change. The test measures the same 25 cold reads with 0 ms and with 150 ms AuthState calls, 3 rounds each, takes the min p95 of each and bounds the difference (< 540 ms = 3 round trips + jitter; the old code is ~600 ms over). Runner speed cancels. Mutation: raising the delay to 260 ms fails it.

Cost if wrong: a regression adding fewer than ~90 ms (under one extra round trip at 150 ms) would slip through; a sub-round-trip slowdown is not what this test guards.
