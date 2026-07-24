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

Non-goals (v1): server-to-server payment capture; per-agent API keys / OAuth; agent-specific
pricing or promos; writing anything beyond a guest order; pagination beyond existing caps.

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

- **Same rules as human guest orders** — no agent-only caps, no COD-only, no value ceiling
  (Ahmad, 2026-07-22).
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
