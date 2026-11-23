# Shopper account closure stuck (P1 "Shopper closure stopped after the store erase")

A shopper's own closure (`POST /auth/me/erase`) erases the store data first (one atomic StoreDO section), then the sign-in record.
If the second step fails twice, the account is locked (inactive, sessions revoked), the shopper gets a 503 `ERASURE_INCOMPLETE`,
and this P1 fires with the store id and user id only.

- The daily `pending-erasure-sweep-daily` cron (03:30 UTC, `data-retention.ts`) re-runs the full erasure for every account that has an
  erasure ledger row but no `erased_at`. Backoff is 1h, 2h, 4h ... up to 24h per user; from the 3rd failed sweep it raises the
  P1 "Shopper account closure is stuck".
- To finish it by hand: the merchant erase route `POST /stores/:storeId/customers/:customerId/erase` (idempotent), or
  `AuthService.eraseAccount(userId, { actorId: 'system', storeHint: storeId })`.
- The ledger row lives 30 days; finish before it expires.
