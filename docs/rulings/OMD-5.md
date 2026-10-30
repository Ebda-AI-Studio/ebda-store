# OMD-5

> Section: 2026-10-01 — owner money decisions (branch `fix/owner-money-decisions-1001`)

**Ruling OMD-5 — 2150 Customer Wallet Liability only ever grows.** It is
credited by partial returns into the wallet (store credit with the wallet on,
and the wallet share of a split gateway refund on an order whose sale was
journaled). Nothing debits it: wallet checkout is refused while accounting is
on (W-3), and admin credits/debits, whole-order wallet reversals and erasure
forfeits are not journaled. No live store has the wallet on (W-1), so the
account stays at 0 in production until one does. Cost if wrong: once a store
turns the wallet on, 2150 overstates what it owes by every credit spent,
adjusted or forfeited, until the W-3 follow-up models the rest.

_Amended 2026-10-29 (Ruling WALLET-GL-1):_ 2150 is now debited by checkout redemption, admin debits and erasure forfeits, and credited by admin credits, so it tracks the sum of wallet balances (pinned by a trial-balance test). The "only ever grows" cost no longer applies.
