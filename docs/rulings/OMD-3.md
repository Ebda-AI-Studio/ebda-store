# OMD-3

> Section: 2026-10-01 — owner money decisions (branch `fix/owner-money-decisions-1001`)

**Ruling OMD-3 — a refund outside a return books to 4090 Sales Returns, with no
tax line and no customer notification.** "A revenue refund" left the revenue
account open; 4090 is the seeded contra-revenue account and was otherwise
unused, so these refunds stay separable from item-level returns (which debit
4000). No tax line because nothing says which lines — and so which tax — the
money was for. `notify: false` because a refund made in the provider's
dashboard has never notified the customer. Cost if wrong: a reclass between two
revenue accounts (P&L total unchanged), or VAT over-declared by the refunded
amount's tax share on a store that charges tax.
