# PREPUSH-5B

> Section: 2026-11-11 CI fast, parallel, never flaky

Ruling PREPUSH-5B - the scanner cache key is computed BEFORE the scanner run (`prepush-scanner-cache.sh key`) and the pass is recorded under that pre-run key (`PREPUSH_CACHE_KEY`), and small ignored inputs (under 64 KiB, e.g. `prisma-meta.json`) are fingerprinted by content while large ones (dist trees) keep size+mtime. Evidence: with a post-run key, a rebuild or edit during the roughly 2-minute scan was recorded as a pass for a state the scanners never saw (test: records under the PRE-run key); mtime alone made a same-bytes rewrite a miss and a same-size edit within one second invisible for small files (test: content hash). Cost if wrong: a large dist file rewritten with the same size inside the same mtime second would still be cached as a pass; CI runs the scanners regardless.
