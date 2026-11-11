import { Router, type NextFunction, type Request, type Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { hashMerchantKey, hasPlausibleMerchantKeyShape } from '../mcp/merchant-auth';
import { featureService } from '../services/feature.service';
import { resolveStoreBySlug } from '../mcp/resolve-store';
import { verifyMerchantKey, MERCHANT_MCP_FEATURE, MERCHANT_KEY_HEADER } from '../mcp/merchant-auth';
import { AppError } from '../middleware/error-handler';
import { rejectBatches } from '../mcp/reject-batches';
import { mcpRequestGuard } from '../mcp/request-guard';
import { makeRateLimitStore, rateLimitRedisClient } from '../middleware/security';
import { ADMIN_WRITE_TOOL_NAMES } from '../mcp/tools/admin-write.tools';
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
 * IP-ONLY backstop, mounted AHEAD of `merchantMcpLimiter` below.
 *
 * `merchantMcpLimiterKey` partitions by (IP, key-fingerprint) so two
 * merchants behind one office IP don't share a budget — but that same
 * partitioning is what a caller with no real key can exploit: an unverified,
 * merely-PRESENT `x-merchant-key` still mints a fresh fingerprint sub-bucket
 * on every request (rotate the value, get a new bucket), so
 * `merchantMcpLimiter` alone never binds that traffic. This limiter keys on
 * `ipKeyGenerator(req.ip)` ONLY — nothing the caller sends can choose or
 * split this bucket — so the global rate-limit bypass this router's path is
 * exempted from (`skipGlobalRateLimit`'s bypass 5) has a REAL compensating
 * control behind it, not just the per-key limiter's stated-but-false one.
 *
 * 300/15min is sized like `refreshIpLimiter` (security.ts): well above any
 * legitimate merchant's real traffic (a bulk catalogue job is many POSTs to
 * the SAME verified key, which `merchantMcpLimiter` below still governs at
 * 120/min), so this backstop is not the ceiling a normal merchant ever
 * notices — it exists purely to bound an attacker who has no key at all.
 */
/**
 * Exported separately from the limiter instance so it can be unit-tested
 * directly — `express-rate-limit` does not expose the raw `keyGenerator` it
 * was constructed with.
 */
export function merchantMcpIpLimiterKey(req: Request): string {
  return `${ipKeyGenerator(req.ip ?? '')}-mmcp-ip`;
}

export const merchantMcpIpLimiter = rateLimit({
  // Resolved per request (#1862): redis.getClient() at module load is null.
  store: makeRateLimitStore(rateLimitRedisClient, 'mmcp-ip'),
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  // Same availability-over-strictness posture as every other limiter here.
  passOnStoreError: true,
  keyGenerator: merchantMcpIpLimiterKey,
  message: { error: 'Too many requests' },
});
// Batches are refused before any limiter (mcp/reject-batches.ts): one POST = one message.
router.use(rejectBatches);
router.use(mcpRequestGuard);
router.use(merchantMcpIpLimiter);

/**
 * Separate from `publicLimiter` (300/min/IP) on purpose: a merchant running a
 * bulk catalogue job is not shopper traffic, and sharing a bucket would let
 * one merchant's legitimate batch throttle a storefront — or the reverse.
 *
 * ALWAYS keyed on IP first, with the key fingerprint (or `none` when absent)
 * as a secondary sub-bucket — `mmcp:${ip}:${fp}` — so this limiter can no
 * longer be read as "the per-key backstop" on its own: it gives two merchants
 * behind one office IP separate headroom, but the actual security ceiling
 * against an unauthenticated/rotating-key caller is `merchantMcpIpLimiter`
 * above, which that caller cannot escape by changing what it sends.
 */
export function merchantMcpLimiterKey(req: Request): string {
  const ip = ipKeyGenerator(req.ip ?? '');
  const presented = req.get(MERCHANT_KEY_HEADER);
  // Never use the credential itself as a bucket key — hash it. A rate-limit
  // store is not a secret store, and the plaintext key would otherwise end
  // up in Redis (and in any dump of it) in clear.
  if (presented) return `mmcp:${ip}:${hashMerchantKey(presented).slice(0, 24)}`;
  return `mmcp:${ip}:none`;
}

export const merchantMcpLimiter = rateLimit({
  // Shared across replicas via Redis (F8, #1862), resolved per request;
  // fail-OPEN on a Redis store error (see middleware/security.ts).
  store: makeRateLimitStore(rateLimitRedisClient, 'mmcp'),
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  passOnStoreError: true,
  keyGenerator: merchantMcpLimiterKey,
  message: { error: 'Too many requests' },
});
router.use(merchantMcpLimiter);

/**
 * Tighter budget for WRITE tool calls, same shape as `writeLimiter`
 * (middleware/security.ts, 30/min) but scoped to this router's own
 * key-fingerprint partitioning (requirement 5, Ahmad 2026-10-10) — a bulk
 * catalogue READ job must not share a budget with — or be throttled by — a
 * handful of order mutations. `skip` is true for every non-write call
 * (reads, `initialize`, `tools/list`), so this limiter is invisible to them;
 * each streamable-HTTP POST carries exactly one JSON-RPC call (array bodies
 * are refused up front by `rejectBatches`, and `adminToolCallLog` below reads
 * `body.params.name` per request), so checking the body here is NOT a race
 * with what actually runs.
 */
function isWriteCallMessage(msg: unknown): boolean {
  const m = msg as { method?: unknown; params?: { name?: unknown } } | undefined;
  return (
    m?.method === 'tools/call' &&
    typeof m?.params?.name === 'string' &&
    ADMIN_WRITE_TOOL_NAMES.has(m.params.name)
  );
}

/** Batches never get this far (`rejectBatches`), so the body is one message. */
function isAdminWriteToolCall(req: Request): boolean {
  return isWriteCallMessage(req.body as unknown);
}

export const merchantMcpWriteLimiter = rateLimit({
  store: makeRateLimitStore(rateLimitRedisClient, 'mmcp-write'),
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  passOnStoreError: true,
  skip: req => !isAdminWriteToolCall(req),
  // Keyed on the presented key's hash ALONE (no IP): one leaked/valid key
  // spread over many source IPs still spends ONE write budget. An unverified
  // key can only ever reach a 404, so its own bucket costs nothing.
  keyGenerator: req => {
    const presented = req.get(MERCHANT_KEY_HEADER);
    return presented
      ? `mmcpw:${hashMerchantKey(presented).slice(0, 24)}`
      : `mmcpw:ip:${ipKeyGenerator(req.ip ?? '')}`;
  },
  message: { error: 'Too many write requests' },
});
router.use(merchantMcpWriteLimiter);

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
  // Cheap, synchronous shape check FIRST — no DB. Rejects the common
  // "no credential" / "obviously garbage credential" case before spending a
  // store-slug resolution + feature lookup on it. `verifyMerchantKey` below
  // still does the real (DB-backed) check once the store is known; this is a
  // fast-reject prefilter, not a replacement — the 404 is byte-identical
  // either way (see verifyMerchantKey's doc comment on why that matters).
  if (!hasPlausibleMerchantKeyShape(req)) {
    throw new AppError(404, 'NOT_FOUND', 'Not found');
  }

  const store = await resolveStoreBySlug(req.params.storeSlug); // throws 404 on miss

  // Fail closed. `merchant_mcp` resolves from the PLAN (Growth + Business) and
  // is OFF for every other store unless a super-admin overrides it — the whole
  // surface is dark by default, the correct posture for full-CRUD control.
  const enabled = await featureService.isFeatureEnabled(store.id, MERCHANT_MCP_FEATURE);
  if (!enabled) throw new AppError(404, 'NOT_FOUND', 'Not found');

  // Rejects (404) on a missing/unknown/revoked/expired/cross-store key.
  // Runs AFTER store resolution so the credential is compared against exactly
  // one already-resolved tenant — there is no decrypt-every-store scan and no
  // window in which a key for store B is evaluated against store A.
  req.auth = await verifyMerchantKey(req, store);

  // Loaded on first call, see mcp.routes.ts.
  const [{ StreamableHTTPServerTransport }, { buildMerchantMcpServer }] = await Promise.all([
    import('@modelcontextprotocol/sdk/server/streamableHttp.js'),
    import('../mcp/merchant-mcp-server.js'),
  ]);
  const server = buildMerchantMcpServer(store);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
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
