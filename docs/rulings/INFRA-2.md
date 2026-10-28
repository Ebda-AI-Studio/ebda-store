# INFRA-2

> Section: 2026-10-07 — INFRA-GAPS (branch `fix/infra-gaps`)

Ruling INFRA-2 — OBSERVATION, not changed: `mergeTracking` lets the NEWEST carrier timestamp decide, and the shipment's own `created` entry is stamped with our clock. A carrier whose event times run behind ours (skew, or local time without offset) would never advance a freshly booked shipment. Not changed here (no incident, behaviour is specified in R-EBDA-004). Cost if wrong: such a shipment shows `created` until a carrier timestamp passes our booking time.
