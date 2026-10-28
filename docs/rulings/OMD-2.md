# OMD-2

> Section: 2026-10-01 — owner money decisions (branch `fix/owner-money-decisions-1001`)

**Ruling OMD-2 — refund methods and return shapes the decision does not cover
keep the previous treatment and are reported, not guessed.** (a) A partial
return completed as `bank_transfer`, `cash` or `manual` still credits the sale's
cash account at the pro-rata figure. `manual` ("Already refunded — record only")
follows an indeterminate gateway refund, so the gateway account is probably
right for it; `bank_transfer` and `cash` arguably belong in 1030 Bank Main or a
cash-on-hand account. (b) A FULL return is still reversed by mirroring the sale
entry (`postRefundJournal`), so a full return settled as store credit or into
the wallet still credits the sale's cash account, not 2150/2160 (#1207 asked for
the same treatment there). (c) A partial return on an order paid partly from
the wallet and partly by CASH ON DELIVERY has no gateway leg (COD has no
provider transaction), so "split to the payment mix" cannot apply; the merchant
picks store credit or bank transfer as before. Each needs the owner. Cost if
wrong: those refunds keep landing in the sale's cash account.
