# Ebda — status

Spend is an estimate from token counts (the cloud session does not expose a dollar meter).

| SP | State | Evidence / PRs | Est. spend |
|---|---|---|---|
| SP10 research | **done** 2026-10-03 | 4 briefs in `docs/research/` — [Whisky-11/ebda#1](https://github.com/Whisky-11/ebda/pull/1) | ~$4 |
| SP3 design + spike | **done** 2026-10-03 (gate taken under "do not stop", see R-EBDA-001) | `docs/design/cloudflare-backend.md`, `spikes/workers-api/` (17/17 on workerd, 0 leaks, mutation-checked), `docs/design/express-on-workerd-experiment.md` — [Whisky-11/ebda#1](https://github.com/Whisky-11/ebda/pull/1) | ~$12 |
| SP4 clone + rebrand | in progress | — | — |
| SP5 self-serve + billing | not started | — | $0 |
| SP6 payments | not started | — | $0 |
| SP7 shipping | not started | — | $0 |
| SP8 WhatsApp free tier | not started | — | $0 |
| SP9 site/docs/help/status | not started | — | $0 |

## Notes
- 2026-10-03: Ahmad said "go", then "do not stop and continue everything in the plan". The SP3 approval gate is therefore recorded as a Ruling for after-the-fact review rather than a hard stop.
- **Ahmad, pricing numbers needed** (after reading `docs/research/pricing-and-packaging.md`): price per tier, free-tier caps, platform fee bps. The engine ships with configurable placeholders until then.
- SP10 caveat: vendor pages were blocked by the sandbox proxy; figures come from search summaries and conflicting ones are marked unverified.
- **SP3 decision for Ahmad's review (R-EBDA-001):** keep FWB's Express API and run it on Cloudflare Workers (no Hono rewrite); per-request Prisma client over Hyperdrive (cache off) to Neon; strict RLS on every tenant table; Cloudflare Containers is the fallback if the Stage 1 concurrency test fails. Overturning it is free until SP4 Stage 1 lands.
- SP3 parity: FWB's buy-flow harness cannot target a Worker yet (it spawns Express itself); the spike suite covers the RLS/cart/webhook assertions, and SP4 adds an `--api-url` mode to the harness.
- Still unproven until a Cloudflare token + Neon project exist: the real Hyperdrive pooler (spike used pgbouncer in transaction mode), edge CPU/cold start.
