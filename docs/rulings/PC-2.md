# PC-2

> Section: 2026-09-25

**Ruling PC-2 — non-EGP money (closed PR #1689) is built in Ebda, not Ebda Store.**
Ebda Store stays EGP-only, which is why #1689 was closed, and its fix was incomplete
(the write path still stores `price * 1000` for every currency). Ebda prices
in EGP (2 decimals), so the currency-aware money layer is Ebda's first task
after the clone. Cost if wrong: Ebda Store becomes 10× wrong the day it takes a
non-EGP store; the currency default is EGP everywhere, so that needs a code
change first, not an accident.
