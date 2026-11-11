import { Router, type NextFunction, type Request, type Response } from 'express';
import { publicLimiter } from '../middleware/security';
import { featureService } from '../services/feature.service';
import { runInStoreScope } from '@ebda/database';
import { resolveStoreBySlug } from '../mcp/resolve-store';
import { classifyToolCall, resolveAgentAuth } from '../mcp/agent-auth';
import { AppError } from '../middleware/error-handler';
import { rejectBatches } from '../mcp/reject-batches';
import { mcpRequestGuard } from '../mcp/request-guard';
import logger from '../lib/logger';
import { searcherFromIp } from '../lib/search/embed-budget';

/**
 * Store-scoped MCP endpoint — stateless Streamable HTTP.
 *
 * POST /api/v1/mcp/:storeSlug — resolves the store by slug (404 on an
 * unknown/inactive/deleted slug, never default-to-first), checks the
 * `agent_checkout` feature gate (404 when disabled — fail closed, no
 * capability leak to unauthorized callers), then builds a fresh
 * McpServer + StreamableHTTPServerTransport pair for this single request
 * (`sessionIdGenerator: undefined` — no server-side session state is kept
 * between requests). Tool registration lands in Tasks 4-6.
 *
 * ## CONTEXT-LESS BY DESIGN — do not add `tenantContext` to this router
 *
 * This is written here, not only in `routes/index.ts`, because this is the
 * file a future reviewer edits. `/mcp` is deliberately mounted WITHOUT
 * `tenantContext`, for the same reason `financeRoutes` and
 * `shippingCarrierRoutes` are:
 *
 *   - `order.tools.ts` opens its OWN `withTenantContext` / `runInTenantContext`
 *     scopes, and `place_order`'s online branch makes an EXTERNAL payment-gateway
 *     HTTP call in-request. Wrapping the router would nest a `$transaction`
 *     inside another and trap a third-party call inside a 30-second interactive
 *     RLS transaction → `P2028 transaction already closed`, connection-pool
 *     exhaustion under any concurrency, and 500s on MCP orders.
 *   - The plain form is worse than useless: `tenantContext` reads
 *     `req.params.storeId || req.params.id` and bails on a non-UUID, and this
 *     router's param is `:storeSlug` — so it would be a SILENT no-op that looks
 *     like protection.
 *
 * ## Auth lives in the TOOL, not here
 *
 * All seven tools plus `initialize` and `tools/list` ride this ONE POST, so any
 * rejecting auth middleware on this router would 401 the handshake and every
 * read as well. `resolveAgentAuth` only ANNOTATES the request (`req.auth`), the
 * SDK forwards that to handlers as `extra.authInfo`, and the two write tools
 * enforce on it. See `mcp/agent-auth.ts`.
 */
const router = Router();
// One JSON-RPC message per POST: a batch would run up to 100 calls for one limiter token.
router.use(rejectBatches);
router.use(mcpRequestGuard);
router.use(publicLimiter);

/**
 * Structured `mcp.tool_call` log line — the only thing that can tell an agent
 * browsing apart from an agent buying. `requestLogger` records the path only,
 * and every MCP call is the same `POST /api/v1/mcp/<slug>` with the same 200.
 *
 * NEVER rejects and NEVER throws: `classifyToolCall` is total, the whole body
 * is wrapped, and every path ends in a BARE `next()`. A `next(err)` here would
 * short-circuit to the error handler and 500 every MCP request, reads included.
 * Runs before store resolution on purpose, so a probe against an unknown slug
 * is logged too — `req.params` is empty at router level, so the slug is read
 * off `req.path`.
 */
function mcpToolCallLog(req: Request, _res: Response, next: NextFunction): void {
  try {
    const { tool, kind } = classifyToolCall(req.body);
    logger.info(
      {
        storeSlug: req.path.split('/')[1] || null,
        tool,
        kind,
        ip: req.ip,
        userAgent: req.get('user-agent'),
        requestId: req.headers['x-request-id'],
      },
      'mcp.tool_call'
    );
  } catch {
    // Observability must never be able to take the surface down.
  }
  next();
}
router.use(mcpToolCallLog);

async function handleMcpPost(req: Request, res: Response): Promise<void> {
  const store = await resolveStoreBySlug(req.params.storeSlug); // throws 404 on miss
  const enabled = await featureService.isFeatureEnabled(store.id, 'agent_checkout');
  // Same AppError(404, 'NOT_FOUND', 'Not found') as resolveStoreBySlug's miss
  // path — byte-identical body so a slug-prober can't distinguish
  // store-not-found from store-exists-but-gated. Do not diverge the code/message.
  if (!enabled) throw new AppError(404, 'NOT_FOUND', 'Not found'); // fail closed, no capability leak

  // Annotate, never reject. `req.auth` is the SDK's own seam: it reads it in
  // `server/streamableHttp.js` and hands it to every tool handler as
  // `extra.authInfo`. Anonymous requests still get a value here (with an empty
  // `scopes` array plus the ip/user-agent an audit row needs) — the WRITE
  // tools are what check the scope. Resolved after the store, so the
  // credential is compared against exactly one, already-resolved tenant.
  req.auth = await resolveAgentAuth(req, store);

  // Loaded on first MCP call, not at boot: the SDK, its zod schemas and the tool modules are
  // ~10 MB of isolate heap that a Worker serving no MCP traffic should not pay for.
  const [{ StreamableHTTPServerTransport }, { buildStoreMcpServer }] = await Promise.all([
    import('@modelcontextprotocol/sdk/server/streamableHttp.js'),
    import('../mcp/store-mcp-server.js'),
  ]);
  // The caller's identity for the query-embed limit (search_products, Ruling SEARCH-T12-6).
  const server = buildStoreMcpServer(store, { searcher: searcherFromIp(req.ip) });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  // Strict RLS: every storefront read/write the tools make (`cart`, `catalog`, ...)
  // needs the store GUC. `runInStoreScope` sets it per QUERY in a short transaction (no
  // long-lived one is held open across `place_order`'s payment-gateway call), and the
  // tools that open their own tenant transaction still nest correctly inside it.
  await runInStoreScope(store.id, () => transport.handleRequest(req, res, req.body));
}

router.post('/:storeSlug', (req, res, next) => {
  handleMcpPost(req, res).catch(next);
});
router.get('/:storeSlug', (_req, res) => res.status(405).json({ error: 'Method Not Allowed' }));
router.delete('/:storeSlug', (_req, res) => res.status(405).json({ error: 'Method Not Allowed' }));

export default router;
