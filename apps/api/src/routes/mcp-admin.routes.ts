import { Router, type NextFunction, type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { hashMerchantKey } from '../mcp/merchant-auth';
import { featureService } from '../services/feature.service';
import { resolveStoreBySlug } from '../mcp/resolve-store';
import { buildMerchantMcpServer } from '../mcp/merchant-mcp-server';
import { verifyMerchantKey, MERCHANT_MCP_FEATURE, MERCHANT_KEY_HEADER } from '../mcp/merchant-auth';
import { AppError } from '../middleware/error-handler';
import logger from '../lib/logger';

/**
 * Store-scoped MERCHANT-ADMIN MCP endpoint — stateless Streamable HTTP.
 *
 * `POST /api/v1/mcp/admin/:storeSlug`
 *
 * This is the "operate my store from Claude Code instead of the dashboard"
 * surface. It is deliberately NOT more tools on `/api/v1/mcp/:storeSlug`.
 *
 * ## The inversion that makes this router simpler than the buyer one
 *
 * `mcp.routes.ts` cannot reject at middleware level: its reads are anonymous
 * by design, and all tools plus `initialize`/`tools/list` ride one POST, so a
 * rejecting guard there would 401 the protocol handshake and take the whole
 * agentic-commerce surface dark. Auth therefore lives inside its two write
 * tools.
 *
 * Nothing here is meant to be anonymous, so the opposite holds: we reject
 * BEFORE building the MCP server. That is worth stating plainly because it is
 * the security property — an unauthenticated caller never receives a
 * `tools/list`, so the admin surface is not advertised to anyone who cannot
 * already use it.
 *
 * ## Three refusals, one response
 *
 * Unknown slug, feature disabled, and bad/missing/revoked/cross-store key all
 * produce `AppError(404, 'NOT_FOUND', 'Not found')` — byte-identical. A prober
 * cannot separate "no such store" from "store exists, merchant_mcp is off"
 * from "store exists, wrong key". Do not give any of them a distinct code.
 *
 * ## No `tenantContext` on this router
 *
 * Same two reasons as the buyer router, and the second is decisive:
 * `tenantContext` reads `req.params.storeId || req.params.id`, and this
 * router's param is `:storeSlug` — mounting it would be a SILENT no-op that
 * looks like protection. Each tool opens its own `runInTenantContext`.
 */
const router = Router();

/**
 * Separate from `publicLimiter` (300/min/IP) on purpose: a merchant running a
 * bulk catalogue job is not shopper traffic, and sharing a bucket would let
 * one merchant's legitimate batch throttle a storefront — or the reverse.
 * Keyed by key fingerprint where present so two merchants behind one office IP
 * do not share a budget.
 */
export function merchantMcpLimiterKey(req: Request): string {
  const presented = req.get(MERCHANT_KEY_HEADER);
  // Never use the credential itself as a bucket key — hash it. A rate-limit
  // store is not a secret store, and the plaintext key would otherwise end
  // up in Redis (and in any dump of it) in clear.
  if (presented) return `mmcp:${hashMerchantKey(presented).slice(0, 24)}`;
  // ipKeyGenerator() normalizes IPv6 to its /64 prefix — an unauthenticated
  // caller cycling the low 64 bits of an IPv6 address would otherwise land in
  // a fresh bucket on every request, defeating the 120/min cap on this
  // credential-stuffing surface (matches security.ts's pattern).
  return `mmcp-ip:${ipKeyGenerator(req.ip ?? '')}`;
}

const merchantMcpLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: merchantMcpLimiterKey,
  message: { error: 'Too many requests' },
});
router.use(merchantMcpLimiter);

/**
 * Structured `mcp.admin_tool_call` log line. Every admin call is the same
 * `POST /api/v1/mcp/admin/<slug>` with the same 200, so `requestLogger` alone
 * cannot tell a merchant reading analytics from one editing the catalogue.
 *
 * NEVER rejects and NEVER throws — the whole body is wrapped and every path
 * ends in a BARE `next()`. A `next(err)` here would 500 every admin request.
 */
function adminToolCallLog(req: Request, _res: Response, next: NextFunction): void {
  try {
    const body = req.body as { method?: unknown; params?: { name?: unknown } } | undefined;
    logger.info(
      {
        storeSlug: req.path.split('/')[1] || null,
        method: typeof body?.method === 'string' ? body.method : null,
        tool: typeof body?.params?.name === 'string' ? body.params.name : null,
        ip: req.ip,
        userAgent: req.get('user-agent'),
        requestId: req.headers['x-request-id'],
      },
      'mcp.admin_tool_call'
    );
  } catch {
    // Observability must never be able to take the surface down.
  }
  next();
}
router.use(adminToolCallLog);

async function handleMerchantMcpPost(req: Request, res: Response): Promise<void> {
  const store = await resolveStoreBySlug(req.params.storeSlug); // throws 404 on miss

  // Fail closed. `merchant_mcp` is in no plan baseline, so this is OFF for
  // every store until a super-admin turns it on — the whole surface is dark
  // by default, which is the correct posture for full-CRUD store control.
  const enabled = await featureService.isFeatureEnabled(store.id, MERCHANT_MCP_FEATURE);
  if (!enabled) throw new AppError(404, 'NOT_FOUND', 'Not found');

  // Rejects (404) on a missing/unknown/revoked/expired/cross-store key.
  // Runs AFTER store resolution so the credential is compared against exactly
  // one already-resolved tenant — there is no decrypt-every-store scan and no
  // window in which a key for store B is evaluated against store A.
  req.auth = await verifyMerchantKey(req, store);

  const server = buildMerchantMcpServer(store);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

router.post('/:storeSlug', (req, res, next) => {
  handleMerchantMcpPost(req, res).catch(next);
});
router.get('/:storeSlug', (_req, res) => res.status(405).json({ error: 'Method Not Allowed' }));
router.delete('/:storeSlug', (_req, res) => res.status(405).json({ error: 'Method Not Allowed' }));

export default router;
