# PC-1

> Section: 2026-09-25

**Ruling PC-1 — the Ebda AI Studio (`ebda.app`) allowlist entries stay.**
The 2026-06-27 rebrand sweep never landed on main, and ~70 references remain.
Almost all of them are CORS/CSP/platform-host allowlists and comments, and the
legacy hosts are still live: on 2026-09-25 `store.ebda.app` 301'd to
`store.ebda.app`, `store.ebda.app` 301'd to `store.ebda.app`, and
`api.ebda.app` still CNAMEs to the Railway API. Removing them
would break every old link and bookmark that still reaches the platform. Only
the user-facing stale values changed: the Swagger contact/terms/server URLs,
the `INNGEST_SERVE_HOST` example in `apps/api/.env.example` and
`docs/ENVIRONMENT.md`, and the boot warning's example. Cost if wrong: the old
hosts stay reachable as an attack surface; revisit when their DNS is retired.
