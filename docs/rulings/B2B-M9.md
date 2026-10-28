# B2B-M9

> Section: B2B wholesale pricing (feat/b2b-wholesale, 2026-10-21)

Ruling B2B-M9 (money review M-9) - Do not merge before Task 6. `audience = wholesale_only` is read nowhere in `apps/api/src` until Task 6; until then a guest can cart and order a wholesale-only product at retail. The branch stays unmerged until B2B is complete. Cost if wrong: a guest could cart and order a wholesale-only product at retail until the audience gate shipped; lifted when Task 6 landed.
