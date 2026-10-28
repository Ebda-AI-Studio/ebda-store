# SN-1

> Section: 2026-09-25 — Sentry open-issues sweep (branch `fix/sentry-open-issues`)

**Ruling SN-1 — FORCE-WEB-K/M/Q (`RangeError: Maximum call stack size exceeded`) and FORCE-WEB-N/P
(`Error: La`) are Chrome for iOS's own injected script, not Ebda Store code; they are filtered at the Sentry
boundary, not "fixed".** All 63 events (100%) are `Chrome Mobile iOS`, zero from Mobile Safari on the
same WebKit engine. Every frame is attributed to the DOCUMENT URL (`app:///`, `app:///products`) at
lines 190-464, while the served HTML is 11-12 lines and the largest `/_next/static/chunks/*.js` the
storefront loads is 51 lines (Playwright WebKit + Chromium, iPhone profile, the breadcrumb sequence
home → category tile → logo/back, x6: no pageerror, 23 JS responses, none ≥190 lines, none defining
`Ok`/`Qk`/`Nk`/`Pk`). The line:col positions are identical across Ebda Store releases two weeks apart
(2214be88 → ad17d6e4) while the Closure-style names change with the Chrome version (152 `Nk`/`Pk`,
154 `Ok`/`Qk`). `isHostInjectedScriptEvent` (`@ebda/shared`) drops an event only when the UA is
Chrome/Firefox/Edge for iOS (`CriOS`/`FxiOS`/`EdgiOS` — NOT the Facebook/Instagram in-app
browsers, which no event evidenced; narrowed in issue 2008), AND no frame comes from a script file,
AND every frame sits past line 100 (the served HTML is ~12 lines, the injected frames 190-464).
Cost if wrong: a genuine recursion in an inline script of ours that happens to sit past line 100
of the document, seen only by Chrome/Firefox/Edge-for-iOS users, would go unreported — every other
browser still reports it, and any frame in a shipped chunk or at a document-sized line keeps it.
