# DEPLOY-R2-POPULATE-1

**Decision:** the storefront deploy calls `opennextjs-cloudflare deploy --cacheChunkSize 4` (instead of `wrangler deploy`, which delegated to the same command with the default of 25 parallel uploads).

**Evidence:** 2026-11-03, run 41654873558 failed twice on the self-hosted Umbra runner at "Populating remote R2 incremental cache": the same 3 incremental-cache entries hit OpenNext's 60 s per-request timeout on every one of 14+ attempts ("Failed to send request to R2 worker: The operation was aborted due to timeout"), while every other app deployed. 25 parallel uploads over the host's uplink leave each large entry too little bandwidth to finish in 60 s.

**Cost if wrong:** a slower populate step (still bounded by DEPLOY-TIMEOUT-1's 15 min); if 4 is still too many, the step fails within 15 min and the value drops further.
