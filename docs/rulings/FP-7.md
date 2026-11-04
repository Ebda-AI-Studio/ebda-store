# FP-7

> Section: Admin fix pass 2026-11-04, track T1 API core (branch `feat/admin-fix-t1-api-core`)

Ruling FP-7 - BE:E-4. The super-admin dashboard, AI usage and usage-history reads run one short tenant transaction per store (`acrossStores`), O(stores) per request with no bound. They now take their store list through `boundedFanoutStoreIds` (`SUPER_ADMIN_FANOUT_CAP` = 500, first 500 by id, a warning is logged when the list is cut). Production has 7 stores, so the cap is inert today; a cursor or a rollup table is the real fix and is a platform decision. Cost if wrong: a platform with more than 500 stores sees partial super-admin totals instead of a slow page.
