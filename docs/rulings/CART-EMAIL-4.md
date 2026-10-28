# CART-EMAIL-4

> Section: 2026-10-16 — Search program, PR 4, Task 13 (quality eval): SEARCH-T13-\*

Ruling CART-EMAIL-4 (2026-10-21) - the link is `/cart` on the store's own origin, not a restore token. Cart emails exist only for carts attached to a logged-in customer (detection requires `cart.customer`), and that cart persists on the account, so signing in restores it (Ruling for issue 2035 stands: no `?recover=&sig=` links, the snapshot cannot rebuild a cart). The step-3 auto-coupon belongs to the push/SMS sequence and is not put in the email. Sent through `ResendService.sendMarketingEmail` with the store's `resolveSender` identity and reply-to; shopper data never goes to an Ebda inbox. Cost if wrong: a shopper on a new device must sign in to see the cart.
