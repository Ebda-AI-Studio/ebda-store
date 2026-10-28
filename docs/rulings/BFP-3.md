# BFP-3

> Section: 2026-09-25 — buy-flow parity harness (`scripts/buy-flow-parity/`)

**Ruling BFP-3: a 5xx body is compared by the LAST line of its message, with
digits masked.** The full dev-mode message holds a Prisma code frame and elapsed
milliseconds, so two runs of the same code differ. Replacing the whole message
hid a real difference: base "Cannot transition from cancelled to refunded" vs
head "Transaction already closed". Cost if wrong: two different failures whose
last lines are identical compare equal.
