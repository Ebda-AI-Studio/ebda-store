# BARCODE-PICK-COUNT-1

**Ruling BARCODE-PICK-COUNT-1 - pick and cycle-count were already shipped (#213); F4 closes their
gaps instead of rebuilding them.** The program handoff said only receiving was wired; main had
`pickOrderItemByBarcode`, the count-session lifecycle, the routes (all `inventory.barcode`,
Enterprise) and the three-mode scan page. What was missing, now fixed: (1) a wrong item on an
order and a surplus unit are 409 `NOT_IN_ORDER` / `ALREADY_PICKED` with a red role=alert warning
in ar/en (the old code answered 404 "not found" or silently clamped the count); (2) reconcile is a
single atomic claim (`updateMany closed -> reconciled`), so two concurrent reconciles post one
adjustment, with a compensating re-open when `createAdjustment`/`postAdjustment` throws, and it
writes an `inventory.count.reconciled` audit row; (3) help articles `barcode-scan-pick-and-count`
(en + ar). Stock still moves only through `createAdjustment` + `postAdjustment`, no raw SQL, so the
Durable Object port (PR D2) re-targets one service. No residuals (coordinator review): (a) the pick is ONE conditional statement
(`WITH cur AS (SELECT ... WHERE picked_qty < quantity FOR UPDATE) UPDATE ... RETURNING`), so two
scanners on a line can never over-pick it; the loser re-resolves to the next open line or
ALREADY_PICKED; (b) reconcile posts a DELTA: each count line keeps `counted - system qty at the
moment of its scan` (a re-scan refreshes both together, so the pair always describes the same
instant), `createAdjustment` takes it as `countDelta` and `postAdjustment(..., { relative: true })`
applies it as an atomic `increment`, so a sale made after the scan is preserved. Evidence:
`tests/integration/barcode-pick-count-race.test.ts` on a real Postgres (12 concurrent scans on a
qty-3 line -> picked exactly 3; stock 10, count 8, sale of 3 -> 5, not 8). Other adjustment types
still write an absolute quantity, unchanged. Cost if wrong: the history row's `newStock` for a
count line is the create-time estimate, not the final stock, if a sale lands between create and post.
