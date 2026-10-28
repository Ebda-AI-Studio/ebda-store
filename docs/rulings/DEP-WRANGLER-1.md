# DEP-WRANGLER-1

> Section: 2026-10-03 — Sentry backlog batch (branch `fix/followups13`, issues 2469–2473)

## Ruling DEP-WRANGLER-1 — wrangler 4.116.0 + miniflare undici override; no prerelease miniflare in the prod tree (2026-10-03)

Decision: wrangler is pinned exactly at `4.116.0` (root `overrides.wrangler` and all three apps). It is the newest wrangler whose `miniflare` dependency is a STABLE release (`4.20260730.0`); wrangler 4.117.0 and every later 4.x pin a `5.x-alpha` miniflare (verified with `npm view wrangler@<v> dependencies.miniflare` for 4.100.0 through 4.147.0). miniflare 4.20260730.0 declares `undici: 7.28.0` exactly, which is inside the advisory range, so `overrides.miniflare.undici = 7.29.1` is REQUIRED again (it was a no-op only while the alpha miniflare declared 7.29.1 itself; #2461). Remove it once a stable miniflare declares undici >= 7.29.1.
Residual: wrangler 4.116.0 depends on `unenv@2.0.0-rc.24` (upstream, the same on every wrangler 4.x including the previous 4.86.0). It is a dev/optional tool dependency, not a runtime dependency of the shipped Worker bundle.
