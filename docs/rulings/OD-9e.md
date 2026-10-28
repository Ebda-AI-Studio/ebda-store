# OD-9e

> Section: 2026-10-01 — owner decisions 6 / 7 / 9 (branch `fix/owner-decisions-6-7-9`)

**Ruling OD-9e — a PINNED sale chip never loses the corner to a custom chip; it moves (issue 2343).**
The pin picked its corner from the platform's own top-edge occupants, so on a store whose merchant
parked the custom label in the reading-start top corner it landed on that corner, and rule 3 ("same
corner → the merchant's chip wins") deleted the -25% chip on every card. Rule 3 exists for two chips
a merchant PLACED; the pinned one was placed by the platform. In exactly that case (a custom chip
renders, the discount is a corner chip, and the pin lands on the custom chip's named corner) the pin
is re-run with the custom chip as a chip-deep occupant: it takes the free top corner, or the row
below the custom chip when the other corner holds a heart, and both render. Nothing else changes:
over the resolver's full input grid (19,200 combinations per flag value) the legacy-corner output is
identical to origin/main (0 differences; frozen by a sha256 in `sale-badge-top-pin.test.ts`), and
with the top pin the ONLY 96 changed combinations are ones where the old code deleted the sale chip
and the new one renders it. Rendered cards (6 paths × en/ar × 6 cases, legacy and default): all 72
legacy-corner screenshots are byte-identical PNGs to origin/main; the 10 that differ are default-
corner cards whose sale chip was missing. Cost if wrong: on a default-corner store with a top-corner
custom label, the custom chip moves down one row when the sale chip takes the other top corner
(rule 4's same-edge stacking), as it already did for any two top-edge chips.
