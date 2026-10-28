# B2B-9a

> Section: B2B wholesale pricing (feat/b2b-wholesale, 2026-10-21)

Ruling B2B-9a (money review M-1; supersedes the "inside the transaction" wording of B2B-9 and the Task 3 table) - Pricing resolves in the request, just before the money transaction opens, with no row lock. Moving it inside the transaction would not close the race (a revoke committing after the in-transaction read still loses under READ COMMITTED unless the `customers` / `customer_groups` rows are read `FOR SHARE`). The binding mechanism is `expectedTotal` (409 `PRICE_CHANGED`), fed by the checkout's server quote. Cost if wrong: an order created within the request window after a revoke / downgrade carries the old price; the merchant cancels it.
