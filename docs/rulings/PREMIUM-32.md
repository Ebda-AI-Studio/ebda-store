# PREMIUM-32

> Section: 2026-11-03 - Storefront premium defaults (PREMIUM-\*)

Ruling PREMIUM-32 - the showroom gold pieces round to a 10 EGP step (`roundingStep: 1000`, the coarsest step the gold-rate doc allows) so prices read 17,820 not 17,822; no storefront display rounding is added (the stored price is the repricer's and checkout charges it). Takes effect on the next showroom seed run. Cost if wrong: the showroom gold prices differ from the exact formula by up to 5 EGP, which the demo labels as illustrative.
