# EWO-C3

> Section: Cluster C — order summaries + tax display

**Ruling EWO-C3 — issues 2207 and 2052 are closed as already fixed on main.** 2207: the orders-PWA
SummaryCard already splits `loyaltyDiscount` out of `otherDiscount`. 2052: the orders PWA takes
both the map and the payment-capture gate from `@ebda/shared` (`orderStatusOptions`), and
`ActionFooter` derives its transitions from that gate. Evidence is in the close comments.
Cost if wrong: none; both are reads of current code.
