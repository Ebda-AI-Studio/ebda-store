# R-EBDA-PRICING-3

> Section: 2026-10-07 — Locked pricing (R-EBDA-PRICING-\*)

Ruling R-EBDA-PRICING-3: the new limit fields on hidden plans are set so no existing store changes behaviour: `maxStores` null (unlimited) on pro/comped, `analyticsTier` advanced, `brandingRemoval` false, `apiAccess` false, except `free`, which has `maxStores` 1 because it is also the fallback a canceled subscription resolves to (a lapsed Business owner must not keep adding stores). Evidence: `plan-gates.test.ts` "hidden legacy plans keep today's behaviour" and the canceled-Business case. Cost if wrong: a legacy `pro` owner could create unlimited stores, or a canceled store is capped at one.
