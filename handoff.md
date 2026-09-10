# Handoff — agent-key admin UI + `agent.write.denied` alerting

_Updated 2026-09-09. Branch `feat/agent-key-admin-ui`, worktree
`_worktrees/force-website-builder__feat-agent-key-admin-ui`, branched off `fix/mcp-agent-write-auth`
@ `a762ea96` (the open PR #1617 that added the credential). The PR for this branch targets
`fix/mcp-agent-write-auth`, NOT `main`, so it stacks on its parent._

_The previous contents of this file described the parent branch's work (MCP agent-write auth,
Rulings M1–M5 + two P1s). That work is complete and lives in PR #1617; its rulings are recorded in
`docs/superpowers/specs/2026-07-22-agentic-checkout-mcp-design.md` §10 and are unchanged here._

## Goal

Close the two gaps the parent PR opened knowingly and listed as debt in its own report:

1. **Every data has a UI.** The agent write credential shipped API-only. `Store.agentApiKey` decides
   whether a merchant's agent checkout works at all, so "mint it with a curl" is exactly the shape
   the repo's every-data-has-a-UI rule refuses.
2. **Nothing alerted on a non-zero `agent.write.denied` rate.** The rows existed; nothing read them,
   so a merchant's broken integration and someone probing the write surface were both
   indistinguishable from a quiet day.

## Rulings (recorded at decision time, per `standard/rulings.md`)

> **Ruling A1 — the credential gets a dedicated `/stores/[id]/agent-key` page, in the Settings hub,
> not a toggle and not a tab on an existing page.** UI rule 4 caps the ThemeTab at 7 toggles and
> sends the next merchant-facing control to its own page; independently, a credential lifecycle with
> a one-time secret reveal and an irreversible destructive action was never toggle-shaped. Settings
> rather than Marketing because it is integration configuration, beside the WhatsApp bridge key.
> Cost if wrong: the page is one more Settings card in a grid that already has 15 — a discoverability
> cost, not a correctness one, and the ⌘K palette entry (with bilingual keyword synonyms) mitigates
> it.

> **Ruling A2 — the escape-hatch state shown on that page is resolved SERVER-SIDE, and the GET
> status endpoint grew an `openWrites` field for it.** The obvious client-side alternative,
> `useFeatures().isEnabled('agent_checkout_open_writes')`, returns `true` for every key while the
> feature map is loading — a deliberate anti-flicker default — so the page would announce "writes
> are open without a key" on the first paint for EVERY store. That is a fail-open rendering of a
> security control. Cost if wrong: one extra cached feature read per page load of a page a merchant
> opens rarely.

> **Ruling A3 — the denial alert classifies by what the caller PRESENTED, not by the denial rate.**
> A store advertising MCP tools in its `llms.txt` will be found by crawlers and generic agents that
> never had a credential and never will; they are refused forever, by design. A count-based alert
> would page on that background from day one, be muted inside a week, and be missing when a paying
> merchant's integration actually broke. `details.credential` already records the discriminator per
> attempt, so the classifier splits `error` (ours, p0), `invalid`/`unconfigured` from ≤2 IPs (a
> stale merchant key, p1 at 3), the same from ≥3 IPs (a sweep, p1 at 10, one platform p0 when 3+
> stores are hit), and `none` (expected background, info at 50). Cost if wrong: a genuine
> low-and-slow probe that presents a credential from ≤2 IPs and stays under 3 attempts per 16-minute
> window is not alerted — accepted, because every one of those writes was refused and audited, and
> lowering the floor is what gets the alert muted.

> **Ruling A4 — `agent.write.failed` is deliberately out of the alert's scope.** An AUTHORISED write
> that then threw is a different class with a different owner and already reaches Sentry from the
> tool handler. Cost if wrong: a systematically failing authorised agent checkout shows up in Sentry
> and in the order numbers, not in this alert.

## Current state

Everything below is done and verified locally. Nothing is deferred.

## Done

- **Admin page** `apps/admin/src/app/stores/[id]/agent-key/page.tsx` + presentational
  `_components/AgentKeyPanel.tsx` — mint / rotate / revoke, one-time reveal modal with copy, rotate
  confirmation (it invalidates the live key with no overlap window), revoke confirmation gated on an
  explicit acknowledgement checkbox. `useRequireFeature('agent_checkout')`. All API traffic through
  `apiGet`/`apiPost`/`apiDelete`.
- **Wiring**: `/agent-key` added to the Settings hub `urlPrefixes`, a `featureKey: 'agent_checkout'`
  Settings card, a ⌘K palette entry with EN+AR keyword synonyms.
- **i18n**: a full `agentKey` namespace plus the Settings card and palette label in BOTH
  `en.json` and `ar.json`. No hardcoded user-facing string; the secret and the header name are
  forced `dir="ltr"` so an Arabic admin does not bidi-reorder them.
- **API**: `GET /stores/:id/integrations/agent-key` gained `openWrites` (Ruling A2), failing closed
  when the feature lookup throws.
- **Alerting**: `apps/api/src/mcp/agent-denial-alerts.ts` (pure classifier) +
  `apps/api/src/lib/inngest/functions/agent-write-denied-watch.ts` (15-minute cron, 16-minute
  window, `withRlsBypass` because audit_logs is RLS and an Inngest worker sets no tenant GUC),
  registered in the function index and dispatching through the existing `sendAlert`. No new
  alerting mechanism, and no cloud-pinned job.
- **Tests**: 5 new unit files (59 tests) + 1 new integration file (9 tests). Unit suite
  239 → 244 files, 2727 → 2786 tests, 0 failed. Integration failing set byte-identical to the
  baseline (13 files, same tests — pre-existing local register→login/admin-token gaps).
- **Mutation record**: 28 → 41 defences, 41 KILLED / 0 SURVIVED. The workflow's `paths:` list grew
  three globs so the gate actually runs on the new defended sources.
- **Docs**: MCP design spec §11, `plan-feature-matrix.md`, `security-overview.md`,
  `defence-mutation-record.md`.

## In progress

Nothing.

## Fixed during review

The pre-push AI gate found a real defect in the classifier and it was fixed
rather than deferred: `ipKey` gave every row with no recorded `ip_address` a
distinct id, so a merchant integration whose rows lost their ip inflated
`distinctIps` past the probing threshold. That is not a cosmetic mislabel — it
relabels the finding `credential_probing` AND raises its firing threshold from
3 to 10, sending the operator after an attacker while the merchant's checkout
stays down and the alert the low threshold exists for fires late or not at all.
Unknown ips now collapse to one bucket, with two tests and a 40th defence
mutation.

A second, deeper one on the next push: `details.credential = 'error'` was
UNREACHABLE for a decrypt failure. `resolveAgentAuth`'s decrypt `catch` set
`expected = ''` and fell through to `'invalid'`, so a wrong or rotated
`ENCRYPTION_KEY` — every agent write on every store refused — was recorded as
callers presenting bad keys, and this classifier would have called it a
credential sweep: a platform p0 sending the operator after an attacker while
the real fix was an env var. The `AgentCredentialOutcome` contract already said
`'error'` meant "lookup/**decrypt** blew up"; the code did not, and the parent's
own unit test asserted the wrong behaviour, so the mutation record was proving a
path the resolver could not reach. Fixed at the source, both directions tested,
41st defence mutation. **This is a change to the PARENT PR's file** — reviewers
of #1617 should see it.

## Left to do

- **Merge order**: this PR targets `fix/mcp-agent-write-auth`. That PR (#1617) must merge to `main`
  first, or GitHub will retarget this one automatically on its merge.
- **The migration is still only applied locally.** Inherited from the parent branch — the two
  additive nullable `ALTER TABLE` statements have not been applied to Neon.
- **Not carried here** (parent's follow-ups, still open): Ruling M5's residual (`wbsApiKey` and
  `metaAccessToken` ciphertext still ride out on `GET /stores/:id` and `provisioning.service`'s wide
  returns — the agent credential is omitted, this branch adds nothing to that pair), and the
  parametrised prohibited-field mass-assignment test.
- **Unproven**: no browser has rendered the new page. The three merchant states are asserted through
  `react-dom/server` static markup (no jsdom/testing-library exists in this repo), which proves the
  markup but not the layout, the modals, or the clipboard path.
