# ICEBERG-BK-2

> Section: Iceberg quick wins (2026-11-10)

**Ruling ICEBERG-BK-2 - R2 `ebda-media` is copied incrementally (etag manifest `media/manifest.json`, age-encrypted, read back, checkpointed every 25) over the Cloudflare REST API at 2 requests/s, after the databases; `media/` has no expiry and keeps deleted and overwritten copies.** Measured 2026-11-10: 259 objects, 23.6 MB; the REST API quota is `q=1200;w=300` shared with wrangler (response headers), and was seen drained (r=0, retry-after 300) by another consumer, so the client honours Retry-After and fails after 3 tries. Encrypted because expense receipt photos live in that bucket. Cost if wrong: the first run (~780 requests) collides with other API use and fails the job once; the DB backup is already stored by then and the next night resumes from the checkpoint.
