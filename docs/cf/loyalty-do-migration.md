# Loyalty on Durable Object stores: one-off ledger migration (Ruling FP-2)

Why: before L-1 a manual award, a signup bonus or a review bonus on a `storage_backend = 'do'` store was written to Postgres
(`loyalty_points`, `loyalty_transactions`) while earn and redeem run on the DO. Those Postgres rows are invisible to the DO.

What the migration does, per store and customer, through the money op `loyaltyImport`:

1. Reads the customer's Postgres `loyalty_transactions` rows.
2. Sends them (at most 500 per call) with their Postgres transaction `id`.
3. The DO skips any row whose id it already holds, inserts the rest (an order the DO does not hold is stored as `NULL`), and applies each
   inserted row's delta once: `points += points`, a positive row adds to `total_earned`, a negative row to `total_redeemed` (the same
   rule as `awardBonusPoints`; the engine-tagged `refund-revoke:` / `redeem-recredit:` adjustments move the balance only), then recomputes
   the tier from `total_earned`.

Idempotent by construction: a row is skipped when the DO already holds it by id OR semantically (one signup bonus per customer, one review bonus per description, one earn / redeem row per order and type, one tagged reversal per order and description, else the same customer / type / points / description / time). A second run reports `inserted: 0`.

**The import also runs by itself.** `LoyaltyService.ensureDoHistory` does it for a customer on their first loyalty touch on the DO (and `ensureDoStoreHistory` for the store-wide admin reads), so there is no window in which the DO answers for a customer whose Postgres history it lacks. The explicit runner below is only a belt-and-braces check.

The runner is `LoyaltyService.migrateLedgerToDo(storeId, { dryRun })` (dry run by default; it must run in a Worker context because the DO is only
reachable through the Worker binding). It reports customers, rows, the Postgres point sum and the DO stats before and after.

Run order (D6 default: dry-run first):

1. Dry run: for each DO store, `SELECT count(*), sum(points) FROM loyalty_transactions WHERE store_id = $1` on Postgres (read-only) and the
   DO's `loyaltyStats`; list the ids the DO lacks. Review the report.
2. Apply: call `loyaltyImport` per customer from a Worker-context script (the DO is only reachable through the Worker binding). Re-run the
   dry run: the difference must be zero.
3. Compare `loyaltyStats` before and after: `totalPointsIssued` rises by exactly the sum of the imported positive rows.

Cost if wrong: points are double counted or lost for the DO stores; the id key makes a re-run safe, and the Postgres rows are left in place
(never deleted by this migration), so a wrong import can be reversed from them.
