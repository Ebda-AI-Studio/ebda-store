# ICEBERG-BK-1

> Section: Iceberg quick wins (2026-11-10)

**Ruling ICEBERG-BK-1 - the nightly backup exports D1 `ebda-identity` (merchant credentials, MFA, passkeys) beside `ebda-platform`, age-encrypted with the same public key; the drill restores it into a scratch local D1 and compares every table; a v2 manifest without it fails.** Iceberg audit #21 measured identity with Time Travel only (30 d). The fixture drill restored it locally on 2026-11-10: `D1 identity: 12/12 tables equal`. The live pull of the 2026-11-10 set confirmed today's production backup has no identity artifact. Cost if wrong: the CI token cannot export `ebda-identity` and the nightly run fails red (loud, Telegram) until the token gets D1 read on it; no silent gap.
