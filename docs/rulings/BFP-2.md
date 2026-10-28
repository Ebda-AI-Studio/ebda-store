# BFP-2

> Section: 2026-09-25 — buy-flow parity harness (`scripts/buy-flow-parity/`)

**Ruling BFP-2: `walletAmount` absent is compared as `0`, in the order row AND in
order-shaped API responses.** The owner specified this for the row. Without it
every scenario diffs on `walletAmount: 0` added by b1b5bbd1. Other wallet
additions (the `reverseWallet` event flag, the `reverse-wallet-payment` step) are
NOT normalised and show as diffs. Cost if wrong: a response consumer that breaks
on a new key is not flagged by this harness.
