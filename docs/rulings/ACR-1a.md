# ACR-1a

> Section: Backlog batch x-api (2026-10-01, branch `fix/backlog-x-api`)

**Ruling ACR-1a — the recovery figures are measured, labelled as last-touch "ordered later"
(issue 2356; amends ACR-1).** `OrderService.createOrder` marks the store's open abandoned cart for
the same cart or customer `recovered` (`recoveredAt`, `recoveredOrderId`) inside the order
transaction, so the three figures are live data, and nulling them left `recovered` rows badged on
the list under a "Not tracked" headline. `getStats` computes them again: count of `recovered`
rows, rate over all abandoned rows, and revenue as the SQL sum of the linked orders that count as
revenue everywhere else (not cancelled/refunded, payment not failed; unpaid COD counts). The labels
say what the number is — "Ordered later" / «طلبوا لاحقًا», not "Recovered" — because the order is
not attributed to a reminder. Cost if wrong: a merchant reads a customer who would have bought
anyway as a later order, which is what the label says.
