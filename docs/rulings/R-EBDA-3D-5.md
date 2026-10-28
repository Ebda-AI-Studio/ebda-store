# R-EBDA-3D-5

> Section: 2026-10-07 — Product 3D models + AR (R-EBDA-3D-\*)

Ruling R-EBDA-3D-5 — the two upload routes run with NO request transaction (mounted above every `/stores/:storeId` tenantContext mount, pinned by `tests/unit/product-model-routes-mount.test.ts`): validate bytes → R2 put → one short `runInTenantContext` write, and the R2 object is deleted when that write fails. Evidence: a 15 MB upload on a mobile uplink can outlive the 30 s request transaction (EBDA-API-2G class). Cost if wrong: an R2 delete that also fails leaves one orphan object for the weekly sweep (logged).
