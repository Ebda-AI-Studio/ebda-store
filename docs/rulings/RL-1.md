# RL-1

> Section: 2026-09-25

**Ruling RL-1 — `POST /api/v1/inngest` is exempted from the global limiter on
`x-inngest-signature` HEADER PRESENCE, not on verifying it in the skip
predicate.** `skipGlobalRateLimit` (`middleware/global-rate-limit-skip.ts`)
only checks the header exists; the actual HMAC check is `inngestServe`'s
(mounted in `index.ts`), which runs on every POST regardless of whether the
global limiter counted the request. Verified against the installed
inngest@4.2.6 source (`srcof inngest@4.2.6`): `InngestCommHandler
.validateSignature` (`src/components/InngestCommHandler.ts:2623-2652`) throws
when `sig` is falsy and `client.mode === 'cloud'`, and otherwise verifies the
HMAC via `RequestSignature.verifySignature` against `signingKey` (+
`signingKeyFallback`); `handleAction` (same file, ~1594-1609) awaits that
result for every POST and returns `{ status: 401 }` **before** touching
`this.fns` or running any step when it did not succeed. `lib/inngest/
client.ts` sets `isDev: config.nodeEnv !== 'production'`, so production is
always `cloud` mode — an unsigned or forged-signature POST is rejected before
any function code runs, so skipping the RATE-LIMIT COUNTER on header
presence alone costs nothing an attacker without `INNGEST_SIGNING_KEY` can
use. Only `POST` on the exact path `/api/v1/inngest` matches (mutation-tested
against a stripped signature check, a lookalike path, a `..`-traversal path,
and a non-POST method — all KILLED, `defence-mutations.json` id
`inngest-bypass-requires-signature-header`). Cost if wrong: if
`INNGEST_SIGNING_KEY` were ever unset in production, `validateSignature`
throws its OWN error ("No signing key found…") before ever reaching the `sig`
check — so a missing key fails the Inngest platform integration outright,
loudly, rather than opening a quiet hole; it does not silently degrade this
bypass into an open one.
