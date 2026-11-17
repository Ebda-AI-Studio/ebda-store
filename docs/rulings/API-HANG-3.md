# API-HANG-3

**Ruling API-HANG-3 - the `api-hang-concurrency` "production-like 150 ms" assertion becomes a relative bound; the 500 ms absolute p95 was runner speed, not a regression.**

Evidence. On #653 (a backup-chunking PR that touches nothing on the cold read path) the test read p50 534 / p95 557 ms against 500; on a laptop it reads ~348 ms. The same runner measures the Worker's startup at ~370 ms vs 115-194 ms locally, i.e. 2-3x slower CPU, which is the extra ~200 ms over 2-3 serial 150 ms round trips. The assertion exists to pin the NUMBER of serial AuthState round trips on a cold read (1 generation read, not three: the pre-API-HANG-1 code is +2 x 150 ms).

Change. The test measures the same 25 cold reads with 0 ms and with 150 ms AuthState calls, 3 rounds each, takes the min p95 of each and bounds the difference (< 450 ms; a cold read is 2 serial round trips = +302 ms measured on the CI runner, the pre-API-HANG-1 code is +595 ms, so about 150 ms of margin on each side). Runner speed cancels. Mutation: a delay of 260 ms (2 x 260 = +520 ms) fails it; the earlier 540 ms bound would NOT have (520 < 540), which a reviewer measured 5/5 green.

Cost if wrong: a regression adding fewer than ~150 ms (one extra round trip at 150 ms is +150 and lands on the bound) could slip through; a sub-round-trip slowdown is not what this test guards.
