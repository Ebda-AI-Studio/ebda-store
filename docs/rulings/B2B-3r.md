# B2B-3r

> Section: B2B wholesale pricing (feat/b2b-wholesale, 2026-10-21)

Ruling B2B-3r - Round half-up, per unit, once. `unit = floor((base * (10000 - bps) + 5000) / 10000)`, `line = unit * qty`, `subtotal = sum(line)`; never round a line from a fractional unit. Cost if wrong: the merchant gains at most 0.5 piastre per unit on a tie.
