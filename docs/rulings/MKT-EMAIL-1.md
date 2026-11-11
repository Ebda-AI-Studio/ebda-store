# MKT-EMAIL-1

> Section: Launch-eve content consistency pass (2026-11-10, branch `fix/marketing-content-consistency`), from the ebda.app content audit (findings C1-C28)

Ruling MKT-EMAIL-1 - hello@, ahlan@, privacy@ and security@ ebda.app all receive mail (Cloudflare Email Routing; checked by Ahmad 2026-11-10, audit C5), so the addresses on the site stay as they are: ahlan@ is the footer/support address, privacy@ the data-protection address on the legal pages. The stale comment in `BRAND.supportEmail` (it said only hello@ and security@ receive mail and the address "must stay hello@", EBDA-BILLFU-5) is corrected; that part of EBDA-BILLFU-5 is superseded. A new public address needs its routing rule before any page shows it. NOT verified by this session (no access to the routing rules); taken from Ahmad. Cost if wrong: mail to one of the published addresses bounces or is dropped silently.
