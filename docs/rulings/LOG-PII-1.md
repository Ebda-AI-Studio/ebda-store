# LOG-PII-1

> Section: Backlog batch followups (2026-10-01, branch `fix/backlog-followups`)

**Ruling LOG-PII-1 — recipient identifiers reach the log drain only masked; the gate is static and
named-field only (issue 2390).** PR 2388 masked the SMS recipient; fourteen sibling log fields in ten
`apps/api` files still carried a raw email or phone (email queue `to`, invoice email, contact form,
low-stock recipient, account lockout ×2, auth ×3, provisioning, socket connect/disconnect, alert
poller sender, and the WhatsApp bridge's hand-rolled `.slice(-4)`). All now go through
`maskEmail` / `maskEmailList` (new, for `EmailOptions.to: string | string[]`) / `maskPhone`.
`tests/unit/no-raw-pii-in-logs.test.ts` walks every `apps/api/src` file's AST and fails on any
`logger.*` / `log.*` / `console.*` object field whose key or value names a contact and whose value
is not a `mask*` / `redact*` / `hash*` call, literal, `.length` or boolean (mutation-proven, with
ten positive and eight negative controls). Not taken: a pino `formatters.log` backstop that masks
by key at runtime — it would re-mask already-masked values lossily and hide the call sites instead
of fixing them. **Amended (issues 2392, 2394) — the gate is now complete over the shapes a syntax
walk can see.** It missed a `...scanResult` spread carrying the owner email
(`stock-low-stock-alert.ts` on-demand twin — now named, masked fields), calls through a bound level
function (`request-logger.ts`, `revalidate-storefront.ts`), and every tree but apps/api. It now
walks apps/{api,web,orders,admin}/src and packages/{shared,database,ui}; resolves aliases
(`const l = logger`, `logger.child(…)`, `logger.warn.bind(logger)`, either branch of a conditional,
a binding annotated `Logger`, `this.<alias>`), element access (`logger[level]`) and `.child({…})`
bindings; checks interpolated and concatenated messages and bare positional values; and fails on
any `{ ...spread }` in a log object that is not in its `REVIEWED_SPREADS` list (13 today, each read
and resolved through the type checker to ids, counts and status only — the list also fails on a
stale entry, so it stays exact). Two dev-seed `console.log`s that printed the admin / load-test
email were rewritten. Every real-file shape was mutation-proven (a field injected into the
request-logger and revalidate objects, a restored `...scanResult`, an interpolated email in an
apps/web file: each goes red). Out of the gate's reach: opaque third-party response bodies
(`body: json` from iCarry, OneSignal, WBS, Unifonic's error body; carrier webhook `payload`), and
the CONTENT of two `Record<string, unknown>` spreads (`logContext` in request-transaction,
`a.context` in unbooked-refund-alert) — the gate pins the spread site, not what a future caller puts
in the record; both callers were read. Cost if wrong: a provider that echoes the recipient in an
error body, or a new caller that puts a contact into one of those two records, writes it to the
drain in the clear on that path. **Amended (issue 2396) — an opaque first argument is a spread.**
pino's first argument IS the merge object, so `logger.info(scanResult, 'done')` writes every key
exactly as `{ ...scanResult }` does, yet the gate required review of the second form only; reverting
the stock-low-stock-alert fix to the bare form (the owner's raw email) stayed green. The gate now
records any identifier / member / element-access / call in argument 0 of a log call (pino and
`console.*` alike) and holds it to `REVIEWED_SPREADS` (19 entries now, from 13: the r2-orphan sweep and gmail poller count objects, the
four OneSignal `meta` logs and three dev-seed
`console.error(e)` catches were read and added), and walks array literals element by element
(`{ items: [{ email }] }` used to be dropped). Mutation-proven: the bare `scanResult` regression goes
red in the real file, and disabling either branch reddens its positive controls. The list is keyed
by file + expression text, not line, so one entry covers every same-text site in a file (the
warehouse sweep's `result` spread and its bare `result` are two shapes under one reviewed reason).
Cost if wrong: a later argument that is not a format value (a custom pino `hooks.logMethod`) would
be merged unreviewed — none is configured today.
