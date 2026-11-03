# PREMIUM-3

> Section: 2026-11-03 - Storefront premium defaults (PREMIUM-\*)

Ruling PREMIUM-3 - hero headline is 36px at 390 wide to 72px from 1100 wide (`clamp(2.25rem, 1.2rem + 4.4vw, 4.5rem)`) on every template hero; a merchant typography-zone size can only raise the ceiling (a 96px pick keeps 96px), never lower the floor. Before, a zone pick pulled it to 14px. The grey 44px pause square becomes a 28px round scrim disc inside the same 44px target, rendered only when the hero really autoplays (more than one slide, motion allowed). Cost if wrong: a merchant who wanted a small hero headline cannot set one; they use a smaller band (CompactHeroBand) instead.
