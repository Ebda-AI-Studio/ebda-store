# ITEST-2

> Section: Lifecycle emails and referral attribution (2026-10-22, branch `feat/lifecycle-emails`)

Ruling ITEST-2 - `search-lexical-rls-index` typeahead latency: on every lane except the nightly schedule (and local runs) the budget is relative to the full-store scan timed in the same test (typeahead < 1.5x scan); the absolute 450 ms ceiling stays on the nightly. The functional assertions (25 rows, all word-start matches) always run. Evidence: the full tier on a loaded runner measured 939 and 1028 ms. Cost if wrong: a typeahead regression that is slower than a plain scan but under 1.5x of it passes on non-nightly lanes until the nightly catches it.
