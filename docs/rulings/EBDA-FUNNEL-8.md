# EBDA-FUNNEL-8

> Section: 2026-10-07 — Signup funnel: plan choice, card on file or InstaPay, 14-day Growth trial (branch `feat/signup-funnel`, stacks on #10)

Ruling EBDA-FUNNEL-8 — `card_setup` is a ledger row of amount 0 that only a `card.saved` / `card.failed` delivery may settle. A card event can never settle a money row, and a charge event can never settle a `card_setup` (`kind_mismatch`). A `card.saved` with no token is settled as failed. Evidence: M2 and M6 mutation proofs. Cost if wrong: n/a; the guards only narrow what a signed webhook can do.
