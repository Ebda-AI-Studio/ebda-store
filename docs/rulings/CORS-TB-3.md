# CORS-TB-3

> Section: Security — credentialed cross-origin tenant binding (issue #622 follow-up, 2026-11-11)

**Ruling CORS-TB-3: `/api/v1/realtime/*` refuses any store origin explicitly, with a 403 `ORIGIN_NOT_PERMITTED`, before a
token is read.**

These routes are the StoreRealtime Durable Object's authority. Their only caller is that DO,
server to server (`cf/store-realtime.ts`), with no Origin. Until now they relied on the
Worker's `/socket.io/` upgrade check (platform origins only) and on CORS-TB-1 to keep
merchant-controlled pages out. A router-level `refuseStoreOrigin` (`routes/realtime.routes.ts`)
makes the boundary local to the route, so it survives a change to the upgrade path.

Platform origins and Origin-less callers still reach `authenticate`.

Tests: `tests/unit/realtime-routes-store-origin.test.ts`. Removing the guard turns 4 cases red.

**Cost if wrong:** a future browser caller on a store origin would get a 403. No browser
calls these routes today, verified with a grep of `apps/` on 2026-11-11.
