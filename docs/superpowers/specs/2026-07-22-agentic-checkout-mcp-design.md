# Agentic Checkout (MCP) — Design Spec

**Status:** approved (Ahmad, 2026-07-22) — ready for implementation planning.
**Item:** OSOSS competitive program, item 7 ("agentic checkout").
**Thesis fit:** directly serves "win on AI / AEO / agentic-commerce." Makes the store
_transactable_ by AI agents, not just _readable_.
**Branch/worktree:** `feat/agent-checkout` → `_worktrees/force-website-builder__feat-agent-checkout`.
**Deploy:** develop-now, merges in the deploy-all-at-once batch.

---

## 1. Problem & premise (verified against source, 2026-07-22)

The read side of agent commerce is fully shipped: OpenAI-style product feed
(`apps/api/src/lib/product-feed.ts`, `GET /public/feed/products.json` behind the `agent_feed`
flag), schema.org JSON-LD on every page (`apps/web/src/lib/structured-data.ts`), and a 3-level
dynamic `/llms.txt` (`apps/web/src/app/llms.txt/route.ts`).

The **guest checkout REST path already works headlessly, no login required**:

- Cart: `POST /public/cart/items`, `GET /public/cart` — session-scoped via `x-session-id`
  header, no auth (`apps/api/src/routes/public.routes.ts:338-391`).
- Order: `POST /public/orders`, `optionalAuthenticate`, `customerId` nullable — guest checkout
  explicitly supported (`public.routes.ts:511-555`).
- Payment intent: `POST /payments/create`, guest via UUID-possession trust model
  (`payment.routes.ts:165-260`); all 4 KW providers return a **redirect** `paymentUrl` (hosted
  page) — there is **no server-to-server card capture**.
- Verify-on-return: `POST /public/orders/:id/verify-payment` (`public.routes.ts:677`).

**The real gap:** no agent-facing _discovery/tool_ layer. No MCP server, no tool manifest, no
way for an LLM agent to _call_ search/cart/order as tools. That is what this builds.

## 2. Goal (one paragraph)

Expose a **store-scoped MCP server** that lets an AI agent (Claude, ChatGPT, etc.) search a
merchant's catalog, build a cart, and place a guest order — reusing the already-shipped public
service layer. Payment completes out-of-band: COD, or a returned hosted-checkout link a human
opens (the provider reality; no autonomous card capture in v1). Agent orders are treated
**exactly like human guest orders** — same fields, same validation, same limits — and stamped
`source: 'agent'` for audit only.

Non-goals (v1): server-to-server payment capture; ~~per-agent API keys / OAuth~~ (**SUPERSEDED by
Ruling M1, 2026-09-09 — see §10**); agent-specific pricing or promos; writing anything beyond a
guest order; pagination beyond existing caps.

## 3. Architecture

- **Location:** new module in `apps/api` (Express, Railway) — NOT a separate worker. It calls the
  existing public **service layer directly** (in-process), never HTTP-hops its own REST routes.
- **Transport:** MCP **Streamable HTTP, stateless** (`@modelcontextprotocol/sdk`,
  `NodeStreamableHTTPServerTransport` with `sessionIdGenerator: undefined`). One `McpServer` +
  transport constructed **per request**, bound to the resolved store. Stateless is correct
  because cart state already lives server-side keyed by a session id — the agent carries the
  `cartId` as a tool argument, so MCP needs no session of its own.
- **Endpoint:** `POST /mcp/:storeSlug`. Custom-domain hosts resolve a store the same way
  `public.routes` already does. **Store resolution reuses the existing resolver and throws/404 on
  an unknown/unresolved id — never default-to-first** (tenant-resolver rule).
- **Discovery:** advertise the `/mcp` endpoint URL in the store's `llms.txt`
  (`apps/web/src/app/llms.txt/route.ts`) when agent checkout is enabled for that store.
- **Entitlement / opt-in:** availability rides the same agent entitlement as `agent_feed` (all
  paid plans). **Default ON** (Ahmad, 2026-07-22 — a deliberate override of the FWB "new capability
  defaults OFF" rule, because agentic commerce is the strategic bet). A **per-store off switch**
  lets a merchant opt out; when off (or plan lacks the entitlement) the endpoint **404s**.

## 4. The tool surface (the interface)

Each tool is a thin, Zod-validated wrapper over a shipped service. All are store-scoped to the
resolved store; none exposes gated PII (seller/customer contact) beyond what the tool's caller
already owns.

| Tool               | Args (Zod)                                                    | Reuses                                     | Returns                                                             |
| ------------------ | ------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------- |
| `get_store_info`   | —                                                             | store service                              | store name, currency, policies, whether ordering is open            |
| `search_products`  | `query`, `limit?`                                             | product/feed service                       | array of `{id,title,price,availability,url,image}`                  |
| `get_product`      | `productId`                                                   | product service                            | full product incl. variants + availability                          |
| `add_to_cart`      | `cartId?`, `productId`, `variantId?`, `quantity`              | cart service                               | `{cartId, items, totals}` — mints a `cartId` (session id) if absent |
| `view_cart`        | `cartId`                                                      | cart service                               | `{items, totals}`                                                   |
| `place_order`      | `cartId`, `customer{name,phone,address,...}`, `paymentMethod` | order service (`POST /public/orders` path) | `{orderId, status, paymentMethod, paymentUrl?}`                     |
| `get_order_status` | `orderId`                                                     | order read                                 | `{status, totals, fulfilment}`                                      |

- `place_order`'s required customer fields = **whatever a human guest order already requires**
  (no more, no less). It stamps `source: 'agent'` on the created order.
- For an online payment method, `place_order` returns the existing hosted `paymentUrl` (redirect
  handoff) + a human-readable instruction. For COD, it returns a confirmed order.
- Errors surface as MCP tool errors with the same codes the REST layer already returns
  (out-of-stock, invalid variant, closed store) — no new error taxonomy.

## 5. Data / attribution

- Add an order provenance marker: `source` (`'web' | 'agent' | ...`) on the order write path (a
  column if not already present; check `Order` schema during planning). Default `'web'`; the MCP
  `place_order` sets `'agent'`. This is **audit-only** — it changes no pricing, no gating, no
  limits.
- No new agent identity table in v1. The existing guest UUID-possession + session model is reused
  verbatim.

## 6. Security & guardrails

- ~~**Same rules as human guest orders** — no agent-only caps, no COD-only, no value ceiling
  (Ahmad, 2026-07-22).~~ **SUPERSEDED by Rulings M1 + M2, 2026-09-09 — see §10.** Reads stay
  anonymous and uncapped; the two WRITE tools (`add_to_cart`, `place_order`) now require the
  store's per-store `x-agent-key` credential.
- Store-scoped throughout; unknown store → 404 (never default-to-first).
- Rate-limited like the feed (≈100 req/min); reuse existing limiter.
- Reuse existing Zod validation at every tool boundary (edge-validation rule).
- No gated data leak: tools return only what the public storefront already exposes. Explicit
  negative tests that seller/customer PII is never returned.
- Endpoint 404s when the store lacks the entitlement or has opted out — fail closed.

## 7. Testing (all layers for a revenue path)

- **Unit:** each tool — arg validation (bad/missing → correct error), correct service call,
  response shape.
- **Integration (Postgres):** full `search_products → add_to_cart → view_cart → place_order →
get_order_status` happy path; opt-in flag on/off → endpoint reachable / 404; oversell and
  invalid-variant rejection; unknown store → 404; guest order created with `source='agent'`.
- **MCP protocol:** a real `@modelcontextprotocol/sdk` client handshake (`initialize` →
  `tools/list` → `tools/call`) against the endpoint, asserting the tool schema and a successful
  order.
- **Blast-radius:** new `source` enum/column consumers; `llms.txt` advertisement; feature-flag
  matrix; any admin order view rendering the new `source`.

## 8. Blast-radius / every-data-needs-a-UI

- `source: 'agent'` on orders MUST surface somewhere a human reads (admin order detail / list
  badge) — otherwise it's dead data. Name the UI surface at plan time.
- `llms.txt` must advertise the `/mcp` endpoint (else agents can't discover it — "built but
  unreachable").
- Feature-matrix + `docs/business/plan-feature-matrix.md` updated in the same session.

## 9. Open items to resolve during planning (not blockers)

- Exact MCP SDK package/version + whether the Express middleware helper or the bare transport is
  cleaner in this codebase (the API bundles its own Express app).
- Whether `Order.source` already exists (grep) or needs a migration (hand-authored, `migrate
deploy`, fresh scratch DB — never `migrate dev`).
- Cart-service reuse details: confirm the exact `x-session-id` cart creation seam so `cartId` ↔
  session id mapping is clean.

---

## 10. Superseding rulings — 2026-09-09

Recorded at decision time per the repo's ruling discipline. Both reverse a ruling written in this
same document on 2026-07-22; neither is an engineering decision taken unilaterally.

> **Ruling M1 — MCP mutating tools require a per-store agent credential; reads stay anonymous.**
> Supersedes the 2026-07-22 "per-agent API keys — non-goal v1" (§2) and "no agent-only caps" (§6)
> rulings. Evidence: production shows 0 agent orders ever across 137 orders and 3 stores, so
> enforcement has no installed base to break, while the surface currently lets any unauthenticated
> caller commit real inventory and money. Cost if wrong: an agent integration we do not know about
> starts getting 401s on writes — detected by the new 401 metric and reversible per store via the
> StoreFeature.

> **Ruling M2 — enforcement defaults ON; the StoreFeature is an escape hatch, not an enable switch.**
> The staged plan proposed shipping `agent_checkout_require_key` in no plan baseline so that
> enforcement would be OFF on ship day, protecting an installed base. There is no installed base
> (0 agent orders, 0 `agent_checkout` StoreFeature overrides, 0 merchant `llms_txt` mentioning MCP),
> and defaulting off would leave the unauthenticated write hole open behind a flag nobody would
> remember to flip. So the credential is REQUIRED by default and the key that exists,
> `agent_checkout_open_writes`, is in NO plan baseline and DISABLES enforcement for one store when a
> super-admin turns it on. Cost if wrong: a merchant with a live agent integration we did not detect
> loses agent writes until a super-admin flips `agent_checkout_open_writes` on for that store —
> which takes effect in ≤300s with no deploy, and the `agent.write.denied` audit rows name exactly
> which store and which caller to unblock.

### What changed in the code (2026-09-09)

| Surface                                                   | Change                                                                                                                       |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/src/mcp/agent-auth.ts` (new)                    | credential resolution (never rejects), the total tool classifier, the `assertAgentWrite` gate, and the write audit helper    |
| `apps/api/src/routes/mcp.routes.ts`                       | `mcp.tool_call` log line; sets `req.auth` after the store + feature gate; "context-less by design" note moved into this file |
| `apps/api/src/mcp/tools/cart.tools.ts` / `order.tools.ts` | `add_to_cart` + `place_order` gated; denied/failed writes audited; success `payment.created` row gains `ip`/`userAgent`      |
| `apps/api/src/routes/agent-credential.routes.ts` (new)    | merchant mint / rotate / revoke at `/stores/:id/integrations/agent-key`                                                      |
| `packages/database/prisma/schema.prisma`                  | `Store.agentApiKey` (AES-256-GCM, same scheme as `wbsApiKey`) + `Store.agentApiKeyRotatedAt`, both nullable and additive     |
| `packages/shared/src/features.ts`                         | `agent_checkout_open_writes` — the escape hatch, in NO plan baseline                                                         |
| `apps/web/src/app/llms.txt/route.ts`                      | the advertisement now states the read/write split and the credential requirement                                             |

### Why the gate is in the tool handler, not in Express middleware

All seven tools plus `initialize` and `tools/list` are multiplexed over ONE `POST /mcp/:storeSlug`.
A `router.use(requireAgentKey)` would 401 the handshake and every read tool, taking the whole
surface dark while `llms.txt` still advertised it. Enforcement therefore rides the MCP SDK's own
seam: a non-rejecting resolver sets `req.auth`, the SDK forwards it to handlers as
`extra.authInfo`, and only the two write tools check it.

---

## 11. The merchant surface and the denial alert (2026-09-09, second pass)

§10 shipped the credential API-only and named two gaps as knowing debt. Both are closed here.

### 11.1 Admin UI — `/stores/[id]/agent-key`

`Store.agentApiKey` decides whether a merchant's agent checkout works at all, so "mint it with a
curl" fails the repo's every-data-has-a-UI rule outright. The credential now has a dedicated page,
not another toggle: UI rule 4 caps the ThemeTab at 7 toggles and sends the next merchant-facing
control to its own `/stores/[id]/<feature>` page, and a credential lifecycle with a one-time secret
reveal and an irreversible destructive action was never toggle-shaped in the first place.

It sits in the **Settings hub** (`/agent-key` registered in `hubs.ts`'s settings `urlPrefixes`),
beside the WhatsApp bridge key — both are integration credentials. Reachable from the Settings card
grid and the ⌘K palette, both gated on `agent_checkout`; the page itself gates again with
`useRequireFeature('agent_checkout')` so a typed URL or a stale bookmark gets the upgrade card, not
the surface.

| Surface                                                   | Change                                                                                                         |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `apps/admin/src/app/stores/[id]/agent-key/page.tsx` (new) | mint / rotate / revoke, the one-time reveal, and both confirmations                                            |
| `…/agent-key/_components/AgentKeyPanel.tsx` (new)         | status + actions, presentational only so all three merchant states are unit-renderable                         |
| `apps/api/src/routes/agent-credential.routes.ts`          | `GET` status gains `openWrites` — the escape-hatch state, resolved server-side                                 |
| `apps/admin/src/i18n/messages/{en,ar}.json`               | the `agentKey` namespace, the Settings card, and the palette label — EN + AR, no hardcoded user-facing strings |
| `hubs.ts` / `buildPaletteItems.ts` / `AdminLayout.tsx`    | settings-hub prefix, palette entry + bilingual keyword synonyms                                                |
| `apps/admin/src/app/stores/[id]/settings/page.tsx`        | the card, `featureKey: 'agent_checkout'`                                                                       |

**Once-only display, and what enforces it.** The plaintext leaves the server exactly once, in the
201 body of the mint/rotate `POST`. `GET` returns `hasKey`, `rotatedAt`, `header` and `openWrites`
and nothing else — asserted, and mutation-tested as `agent-key-status-never-returns-the-key`. In the
browser the key lives in component state for as long as the reveal modal is open: never
`localStorage`, never the URL, never re-fetched, and the modal cannot be reopened. A lost key is
ROTATED, not recovered — which is why rotate has its own confirmation: it invalidates the previous
key with no overlap window, so a merchant rotating "to look at it again" has just broken their live
integration. Revoke is worse still and is gated behind an explicit acknowledgement checkbox that
states the consequence, with the destructive button disabled until it is ticked.

**`openWrites` is resolved server-side on purpose.** The obvious client-side alternative,
`useFeatures().isEnabled('agent_checkout_open_writes')`, returns `true` for EVERY key while the
feature map is loading (a deliberate anti-flicker default), so the page would announce "writes are
open without a key" on the first paint for every store — a fail-open rendering of a security
control. The API answers it instead, and answers `false` when its own lookup throws
(`agent-key-openwrites-status-fails-closed`).

### 11.2 Alerting on the denial rate

`agent.write.denied` rows existed; nothing read them. `apps/api/src/mcp/agent-denial-alerts.ts` is
the pure decision function and
`apps/api/src/lib/inngest/functions/agent-write-denied-watch.ts` the 15-minute cron that feeds it
through `withRlsBypass` (audit_logs is RLS; an Inngest worker sets no tenant GUC, so a plain read
returns zero rows and the watcher would report healthy forever) and dispatches through the existing
`sendAlert`. No new alerting mechanism, and nothing pinned to GitHub-hosted CI.

**Window 16 min, cron every 15 min.** The one minute of overlap means a row on a tick boundary is
never dropped by a late scheduler; because the window matches the cadence, an ongoing incident
re-alerts at most once per 15 minutes per class per store.

**The rate alone is never the signal.** A store advertising MCP tools in its `llms.txt` will be
found by crawlers and generic agents that never had a credential; they are refused, forever, by
design. An alert on the raw denial count would page on that background from day one, be muted
within a week, and be missing when a paying merchant's integration actually broke. What the caller
PRESENTED is the signal, and `details.credential` already records it per attempt:

| Class                | Predicate                                                                 | Threshold / 16 min | Level                                          |
| -------------------- | ------------------------------------------------------------------------- | -----------------: | ---------------------------------------------- |
| `platform_fault`     | `credential = 'error'` — our own DB/decrypt failure, blamed on the caller |                  3 | **p0** platform                                |
| `integration_broken` | `credential ∈ {invalid, unconfigured}` from **≤2** distinct IPs           |                  3 | **p1** store                                   |
| `credential_probing` | same, from **≥3** distinct IPs                                            |                 10 | **p1** store; **p0** platform at ≥3 stores hit |
| `anonymous_flood`    | `credential = 'none'` — no header at all                                  |                 50 | **info** store                                 |

A merchant's own broken integration and a probe both PRESENT a credential, so the count cannot
separate them: the **distinct source IP spread** does. A merchant's agent runs from a small stable
egress set and repeats one wrong key; a probe sweeps from many addresses, or many stores. The
thresholds are asymmetric on purpose — `integration_broken` fires at 3 because it is rare (it takes
a merchant who HAD a key) and means a paying customer's automation is down right now, while
`credential_probing` fires at 10 because a refused write is already the gate working. A sweep across
3+ stores is ONE incident and collapses to a single platform p0 rather than N store alerts, which is
the same "mute me" failure by a different route.

`agent.write.failed` (an AUTHORISED write that then threw) is deliberately out of scope — a
different class with a different owner, already reaching Sentry from the tool handler.

### 11.3 A defect this exposed in the resolver (2026-09-09)

Building the `platform_fault` class required checking what actually sets
`details.credential = 'error'`, and the answer was "only a DB `findUnique` throw". The decrypt
`catch` in `resolveAgentAuth` set `expected = ''` and fell through to `'invalid'`, so a wrong or
rotated `ENCRYPTION_KEY` — the exact "every agent write on every store is refused" outage the p0
exists to name — was recorded as callers presenting bad keys. Fed to this classifier it would have
come out as `credential_probing` across many stores, i.e. a **platform p0 telling the operator to
hunt an attacker** while the real fix was an environment variable, and the body naming
`ENCRYPTION_KEY` would never have appeared.

The `AgentCredentialOutcome` contract already said `'error'` meant "lookup/**decrypt** blew up"; the
code just did not do it, and `mcp-agent-write-auth.test.ts` asserted the wrong behaviour, so the
mutation record was proving a path the resolver could not reach. The `catch` now sets `'error'` and
skips the compare; `'invalid'` is reserved for a successfully-decrypted key that does not match, and
both directions are asserted and mutation-tested (`agent-decrypt-failure-is-not-a-bad-key`).
