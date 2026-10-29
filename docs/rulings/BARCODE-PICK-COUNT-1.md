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
Durable Object port (PR D2) re-targets one service. Residuals left as they were: the pick update is
a read-then-write (two scanners on the same line can both pass the quantity check; picking moves no
stock and the next progress read shows the truth) and reconcile sets stock to the counted number,
not counted minus later sales. Cost if wrong: a surplus unit could be recorded as picked by a
simultaneous scan, or a sale made during a count is overwritten by the counted figure.
