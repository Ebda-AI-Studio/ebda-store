# OMD-6

> Section: 2026-10-01 — owner money decisions (branch `fix/owner-money-decisions-1001`)

**Ruling OMD-6 — #1956 ships at the money level; the GL books nothing for a
wallet-paid order.** W-3 still refuses to journal the sale of any order with
`walletAmount > 0`, so its partial returns find no sale entry and post nothing
(pinned). The poster's wallet leg (CR 2150 for the `return-wallet-share` rows)
is in place for when W-3 is lifted. Residuals: the wallet share is credited
after the provider refund, on the request transaction — if that credit fails,
the request 5xx's with the card refund already sent, the return stays
`received`, and "Already refunded — record only" then records it WITHOUT the
wallet share, which the merchant must add from the Wallet page. When a split
leaves the gateway nothing to send (an order paid entirely from the wallet, or
a rounding fils) no provider call is made. Cost if wrong: that customer's wallet
share is added by hand.

_Amended 2026-10-29 (Ruling WALLET-GL-1):_ W-3 is lifted, so a wallet-paid order now HAS a sale entry (DR 2150 for the wallet part) and its partial returns post their adjustments, including the CR 2150 wallet leg. The "GL books nothing" statement above no longer holds.
