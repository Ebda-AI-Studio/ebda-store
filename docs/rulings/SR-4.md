# SR-4

> Section: 2026-09-16

**Ruling SR-4 — the retry page carries NO `noindex`; the HTTP 500 is the
indexing guard.** A draft rendered `<meta name="robots" content="noindex,nofollow">`
inside the fallback body and the plan presented it as delivered protection. It
was inert, and measured rather than assumed: `<meta>` hoisting into `<head>` is
a React 19 feature, `require('react/package.json').version` is **18.3.1**, and
the root `package.json` `overrides` hard-pins `"react":"18.3.1"` — so the tag
rendered in `<body>`, where Google ignores robots directives. Removed rather
than left as protection-shaped dead weight. A server-component throw returns
500, which crawlers treat as temporary and which does not deindex, unlike the
404 this work removes. Cost if wrong: during a long 429 burst a crawler could
index a retry page it fetched at 500 — contradicting its own status — and the
fix is a `head`-level tag or a React 19 upgrade, not a body tag.
NOTE: `components/StoreMaintenance.tsx:63` has the IDENTICAL inert in-body
`robots` meta for the suspended-store page. Pre-existing and outside this
fix's approved scope — reported, not changed.
