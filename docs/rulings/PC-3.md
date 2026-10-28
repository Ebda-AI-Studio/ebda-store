# PC-3

> Section: 2026-09-25

**Ruling PC-3 — the storefront shimmer/stagger (design batch item 3) stays removed.**
The audit flagged `.shimmer` and the empty stagger class as unfinished work.
They are not: Ahmad had them reverted as a P0 on 2026-07-13 (PR #726) after
the always-on shimmer made every image slot on demo-merchant flicker and sweep
rightward, even in RTL. PR #726 kept the keyframes on purpose for a future
skeleton wired to real image-load state. Cost if wrong: none today; building
that skeleton is new work, not unfinished work.

Context: issue #1841 — a scoped audit found the SR-7 "Go Home" suppression
(below) over-broad.

**SECOND CORRECTION to SR-7 — the suppression is platform-host-scoped, not
global.** The first correction (2026-09-16, below) fixed a real defect — the
link walking a platform-host shopper onto `ebda.app` — but then suppressed
"Go Home" on EVERY host during a transient, including custom domains, where
its own text already said "Custom-domain stores were never affected." On a
custom domain (`demo-merchant.com` etc. — the majority production configuration)
`useStoreUrl`'s prefix is `''` regardless of whether the store resolved for
THIS request, so `storeUrl('/')` is `/`, which on that host already IS the
merchant's storefront home — there is no platform pitch to redirect to.
Suppressing it there took away a working escape route for no reason, and
combined with Ruling SR-5 (8 of 11 store-resolving routes have no chrome) left
a custom-domain shopper on a page with zero links. `RouteErrorFallback.tsx` now
gates the suppression on `useIsPlatform()` (new hook, `StoreContext.tsx`) as
well as `isTemporarilyUnavailable`: hidden only when both are true. Same defect
shape as the first correction — a narrow rebuttal ("the link resolves to `/`")
that stopped one line short of asking what `/` means on THAT host. Cost if
wrong: a platform-host shopper could again see "Go Home" during a transient if
`isPlatform` is ever miscomputed — mitigated by seeding it server-side from
`middleware.ts`'s `x-is-platform` header (Ruling below, same commit) rather
than trusting only the client re-detection.

**Ruling — `StoreContext`'s `isPlatform` is now seeded server-side, not
discovered only in a `useEffect`.** `useStoreUrl`'s `isPlatform` used to start
`false` on every render and correct itself after mount via
`isPlatformHost(window.location.hostname)`, so the server-rendered HTML on a
platform host shipped a bare `/` home href before hydration — reachable by a
pre-hydration click or a crawler following the raw href (issue #1544).
`middleware.ts` already computes this exact answer and sets `x-is-platform`;
`layout.tsx` now reads it and passes `initialIsPlatform` into `StoreProvider`,
which seeds `isPlatform` state from it (falling back to the old client-only
detection when the header is absent, so no caller can fail to compile or lose
behaviour). `useStoreUrl()` and the new `useIsPlatform()` hook both read this
one context value instead of each re-deriving it. Cost if wrong: a route that
somehow bypasses `middleware.ts` (none known) would see the pre-existing
client-only behaviour, unchanged from before this fix.
Context: branch `fix/p2-r2-money` — money batch R2 (18 issues: refunds, returns,
order lifecycle, VAT report, checkout). Owner rule for the batch: nothing changes
how buying or paying works unless an issue requires it. PRs #1969 (returns and
refunds) and #2007 (order lifecycle) were open, unmerged, on the same files.
