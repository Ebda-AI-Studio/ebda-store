# Rotate the Bosta webhook secrets (all stores)

Why: before SEC-8 (2026-10-26 audit, M-132) the per-store Bosta secret in
`/webhooks/shipping/bosta/:storeId/:token` was written to request logs, Workers Logs and Logpush
(30-day retention). Ebda generates the secret (`crypto.randomBytes(24)`), so rotating it kills every
token already logged. Do it once, right after the SEC-8 change is deployed and verified.

1. Confirm the API is on a commit that includes SEC-8 (`curl https://api.ebda.app/health`, compare
   `commit` to the tip of `main`).
2. Dry run (lists the stores that would change, writes nothing; the default mode is a HARD rotation):
   `railway run --service api -- npx tsx ../../scripts/rotate-bosta-webhook-secrets.ts`
3. Apply, in a quiet hour:
   `railway run --service api -- npx tsx ../../scripts/rotate-bosta-webhook-secrets.ts --apply`
   One store only: add `--store <id|slug>`. A merchant can also press Rotate on the Bosta card
   (`POST /stores/:id/shipping-carriers/webhook-secret/bosta/rotate`).
4. What changes: the SEC-8 rotation is HARD (the script's default), because the old token is considered
   LEAKED (it sat in logs for up to 30 days). The old URL token and header die immediately and any
   previous secret is dropped. Bosta keeps the URL it received when each delivery was created, so
   in-flight Bosta shipments stop pushing status (their callbacks answer 401) and fall back to the
   tracking poller (Bosta is `polling: true`); status then arrives on the poll cadence instead of
   instantly. Shipments created after the rotation use the new URL.
   A graceful rotation exists for non-security cases only: `--grace --reason "<why>"` keeps the old
   token for shipments created before the rotation until they are delivered or 30 days pass (and then
   the old token may only update those older, still-open shipments). The script refuses `--grace` when
   the reason describes a leak or compromise.
5. Verify: create a test shipment for one store and watch its status update; check a log line for
   `/shipping/bosta/<id>/[Filtered]` (the token is redacted).

Not covered: Cloudflare's own invocation logs still hold the old URLs; after a hard rotation those
tokens are dead.
