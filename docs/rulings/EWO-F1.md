# EWO-F1

> Section: Cluster F — agent discovery, llms.txt, SEO, i18n

**Ruling EWO-F1 — #2174: the `viaCookie → private` branches in llms.txt / acp.json / ucp are
KEPT as an unreachable second line of defence, with their comments rewritten; they are not
deleted.** middleware.ts's `URL_KEYED_PUBLIC_PATHS` guard (#1959) never reads the sticky cookie on
these four paths, and the middleware now also strips a client-supplied `x-store-slug-source`, so
`resolvedViaCookie()` is false for every real request. Deleting the branches would leave the
middleware's `x-store-slug-source` assertion with no reader. The comments now name the middleware
guard as load-bearing, and `tests/unit/agent-discovery-real-path.test.ts` drives `middleware()` and
feeds the route only what it forwarded (mutating the guard to `false` turns 6/7 red). Cost if wrong:
dead code that a reader could still mistake for the real control — mitigated by the comments and
the real-path test.
