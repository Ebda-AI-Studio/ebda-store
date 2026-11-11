# Support page and home cost line (audit M-033, M-031, M-039)

- `/support` and `/en/support` (copy in `apps/marketing/src/lib/support-page.ts`, linked from every footer through `siteFooter` in
  `packages/shared/src/brand/index.ts`). Source of the policy: Ahmad, 2026-11-11. Support is 24/7: the Ebda AI Studio assistant
  replies first, a person is the backup. Money, account access and security, complex technical problems and complaints go to a
  person. No response-time figure is published because none is measured; add one only when a measured number exists.
  There is no placeholder left to confirm.
- M-031: the line "no commission, X EGP a month on other platforms" (`apps/marketing/src/lib/positioning.ts`, Ruling POSITION-1b) now
  sits on the Studio home (Ebda Store window) as well as on `/store`. The fee is 1% (online fee in
  `business/ebda/research/2026-11-02-competitor-prices.md`), so 50,000 EGP of orders is 500 EGP a month. The earlier 2% had no
  source in that research. No competitor is named.
- M-039: measured 2026-11-11 on live ebda.app, Arabic, 360px, all 32 sitemap pages: scrollWidth 360 on every one. Already fixed
  (MKT-IMPECCABLE-2 and later); `tests/marketing-layout/mobile-overflow.spec.ts` now also covers `/store`, `/services`, `/refund`
  and `/support` (28 cases, pass on a local static build).
