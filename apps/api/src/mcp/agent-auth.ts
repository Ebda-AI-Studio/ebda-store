import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { prisma, runInTenantContext } from '@force/database';
import type { McpStore } from './resolve-store';
import { encryption } from '../services/encryption.service';
import { featureService } from '../services/feature.service';
import { auditLog } from '../middleware/security';
import { AppError } from '../middleware/error-handler';
import logger from '../lib/logger';

/**
 * Agent identity for the store-scoped MCP endpoint — read/write split.
 *
 * ## Why this is not Express middleware
 *
 * All seven MCP tools plus `initialize` and `tools/list` are multiplexed over
 * ONE `POST /api/v1/mcp/:storeSlug`. A `router.use(requireAgentKey)` would
 * therefore 401 the protocol handshake and every read tool as well as the two
 * writes — the whole surface would go dark while `llms.txt` kept advertising
 * it. So nothing here ever rejects a request. `resolveAgentAuth` ANNOTATES the
 * request (`req.auth`), the MCP SDK forwards that annotation to every tool
 * handler as `extra.authInfo` (`server/streamableHttp.js` reads `req.auth` and
 * passes it through `shared/protocol.js`'s `authInfo:` field), and the two
 * write tools — and only they — call `assertAgentWrite` on it.
 *
 * ## What counts as a write
 *
 * `place_order` commits money and inventory. `add_to_cart` commits neither,
 * but it is the only way to obtain the `cartId` `place_order` consumes, and it
 * creates unbounded Cart/CartItem rows for an unauthenticated caller, so it is
 * classified as a WRITE: leaving it open would leave both the row-growth
 * vector and the checkout on-ramp open while protecting nothing an agent
 * needs in order to browse. A browsing agent evaluates a catalogue entirely
 * through `search_products` / `get_product` / `get_store_info`, all of which
 * stay anonymous.
 *
 * `view_cart` stays a READ (it is a lookup by a caller-supplied id) even
 * though `CartService.getOrCreate` mints an empty Cart row on a miss. That
 * residual row-creation is accepted, bounded by `publicLimiter` (300/min/IP),
 * and recorded as such in the PR — it is not a money or inventory path.
 *
 * ## The credential
 *
 * Per store, opt-in, presented as `X-Agent-Key`, stored AES-256-GCM-encrypted
 * in `Store.agentApiKey` with the SAME `encryption.service` scheme the WBS
 * bridge key uses — deliberately reusing that machinery rather than inventing
 * a second credential scheme. Two differences from `waBridgeAuth`, both
 * improvements it could not make:
 *
 *   - **Tenant-pinned by construction.** The store is already resolved from
 *     the URL slug, so exactly ONE row is read and compared. There is no
 *     decrypt-every-store scan, and a key minted for store B presented to
 *     store A's endpoint simply does not match store A's key.
 *   - **Constant-time compare** over SHA-256 digests, not `===`.
 *
 * The plaintext key is never logged, never used as a cache/rate-limit key,
 * and never leaves this module: `AuthInfo.token` carries a truncated SHA-256
 * FINGERPRINT so a request can be correlated in logs without the credential
 * appearing in any of them.
 */

/** Header an agent presents its per-store write credential in. */
export const AGENT_KEY_HEADER = 'x-agent-key';

/** Scope that authorises the MCP write tools. Absent = writes are refused. */
export const AGENT_WRITE_SCOPE = 'agent:write';

/**
 * Escape-hatch feature key (Ruling M2). In NO plan baseline, so it is OFF
 * everywhere and the default posture is enforcement ON. A super-admin turns
 * it on for ONE store to disable the credential requirement there — the
 * per-store, no-deploy rollback lever.
 */
export const AGENT_OPEN_WRITES_FEATURE = 'agent_checkout_open_writes' as const;

/** Tools that mutate. Kept as data so the classifier and the docs can't drift. */
export const MCP_WRITE_TOOLS: ReadonlySet<string> = new Set(['add_to_cart', 'place_order']);

/** Tools that only read. Anonymous, forever — this is the strategic surface. */
export const MCP_READ_TOOLS: ReadonlySet<string> = new Set([
  'get_store_info',
  'search_products',
  'get_product',
  'view_cart',
  'get_order_status',
]);

export type McpToolKind = 'read' | 'write' | 'protocol' | 'unknown';

export interface McpToolCallInfo {
  /** Tool name for a `tools/call`, else null. */
  tool: string | null;
  kind: McpToolKind;
}

/**
 * Classify one JSON-RPC message. TOTAL by construction — every branch returns,
 * nothing dereferences without a type check.
 */
function classifyOne(message: unknown): McpToolCallInfo {
  if (message === null || typeof message !== 'object') return { tool: null, kind: 'unknown' };
  const method = (message as { method?: unknown }).method;
  if (typeof method !== 'string') return { tool: null, kind: 'unknown' };
  if (method !== 'tools/call') return { tool: null, kind: 'protocol' };

  const params = (message as { params?: unknown }).params;
  const name =
    params !== null && typeof params === 'object' ? (params as { name?: unknown }).name : undefined;
  if (typeof name !== 'string' || name.length === 0) return { tool: null, kind: 'unknown' };

  if (MCP_WRITE_TOOLS.has(name)) return { tool: name, kind: 'write' };
  if (MCP_READ_TOOLS.has(name)) return { tool: name, kind: 'read' };
  return { tool: name, kind: 'unknown' };
}

/**
 * Classify a whole request body so a log line can tell a browse from a
 * checkout attempt — today every MCP call is the same `POST /mcp/<slug>` with
 * the same 200, which is why this surface has been unmeasurable.
 *
 * MUST be a TOTAL function. It runs in Express middleware, so a `TypeError`
 * here would reach `next(err)` and 500 EVERY MCP request, reads included
 * (FM-3). A batched JSON-RPC body is an ARRAY; a notification has no `params`;
 * a malformed body can be `null`, a string, or `{}`. Every one of those must
 * return a verdict.
 *
 * Totality is owned by `classifyOne`'s type guards and NOTHING ELSE here — no
 * belt-and-braces `try/catch` wrapper, deliberately. A redundant wrapper would
 * make the guards unmutatable: delete one and the wrapper silently produces the
 * same answer, so `test:defence-mutations` scores the control SURVIVED and the
 * record would say the guard is decorative when it is the only thing holding
 * the property. The caller (`mcpToolCallLog` in `mcp.routes.ts`) has its own
 * `try/catch` as the production backstop, which is the right place for it.
 */
export function classifyToolCall(body: unknown): McpToolCallInfo {
  if (Array.isArray(body)) {
    const parts = body.map(classifyOne);
    // A batch containing a write IS a write for reporting purposes.
    return (
      parts.find(p => p.kind === 'write') ??
      parts.find(p => p.kind === 'read') ??
      parts[0] ?? { tool: null, kind: 'unknown' }
    );
  }
  return classifyOne(body);
}

/** Outcome of examining the presented credential, for logs and audit rows. */
export type AgentCredentialOutcome =
  | 'none' // no X-Agent-Key header was sent
  | 'valid' // matched this store's key
  | 'invalid' // presented, did not match this store's key
  | 'unconfigured' // presented, but this store has no key minted
  | 'error'; // lookup/decrypt blew up — treated as not-authorised

/** How (if at all) this request became authorised to write. */
export type AgentWriteGrant = 'credential' | 'open_writes' | 'denied';

/** The `AuthInfo.extra` payload this module attaches. Never holds a secret. */
export interface McpAgentContext extends Record<string, unknown> {
  storeSlug: string;
  ip?: string;
  userAgent?: string;
  requestId?: string;
  credential: AgentCredentialOutcome;
  grant: AgentWriteGrant;
}

// The SDK declares this augmentation in `server/auth/middleware/bearerAuth.d.ts`,
// which nothing here imports. Declaring the identical shape keeps `req.auth`
// typed without pulling the OAuth middleware in. `req.auth` has 0 other uses
// repo-wide, so there is no collision.
declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthInfo;
  }
}

/** Constant-time compare over fixed-width digests (no length side channel). */
function secretsMatch(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash('sha256').update(a, 'utf8').digest(),
    createHash('sha256').update(b, 'utf8').digest()
  );
}

/** Correlatable, non-reversible stand-in for the key. NEVER the key itself. */
function fingerprint(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 16);
}

/**
 * Resolve the MCP write authorisation for this request. NEVER throws, NEVER
 * rejects, and always returns a value — an anonymous read must be completely
 * unaffected by anything that happens in here.
 *
 * Called from `mcp.routes.ts` AFTER the store is resolved and the
 * `agent_checkout` gate has passed, so the credential lookup is a single
 * primary-key read against the one store the slug named.
 */
export async function resolveAgentAuth(req: Request, store: McpStore): Promise<AuthInfo> {
  const context: McpAgentContext = {
    storeSlug: store.slug,
    ip: req.ip,
    userAgent: req.get('user-agent') ?? undefined,
    requestId: (req.headers['x-request-id'] as string | undefined) || undefined,
    credential: 'none',
    grant: 'denied',
  };

  let token = '';
  let clientId = 'anonymous';

  const presented = (req.header(AGENT_KEY_HEADER) ?? '').toString().trim();
  if (presented) {
    try {
      const row = await prisma.store.findUnique({
        where: { id: store.id },
        select: { agentApiKey: true },
      });
      if (!row?.agentApiKey) {
        context.credential = 'unconfigured';
      } else {
        let expected = '';
        let decryptFailed = false;
        try {
          expected = encryption.decrypt(row.agentApiKey);
        } catch {
          // OUR failure, not the caller's — a rotated/wrong ENCRYPTION_KEY or a
          // corrupt ciphertext. Reporting it as `invalid` (which this did until
          // 2026-09-09) blames the merchant for a platform outage and, worse,
          // hides it: `agent-write-denied-watch` classifies by exactly this
          // field, so a wrong ENCRYPTION_KEY refusing EVERY agent write on
          // EVERY store surfaced as "someone is probing the write surface"
          // instead of the p0 that names ENCRYPTION_KEY as the fix. `error` is
          // what the AgentCredentialOutcome contract has always said this is
          // ("lookup/decrypt blew up"); the code just did not do it.
          expected = '';
          decryptFailed = true;
        }
        if (decryptFailed) {
          context.credential = 'error';
        } else if (expected && secretsMatch(expected, presented)) {
          context.credential = 'valid';
          context.grant = 'credential';
          clientId = `store:${store.id}`;
          token = fingerprint(presented);
        } else {
          context.credential = 'invalid';
        }
      }
    } catch (err) {
      // Never log the presented key, and never fail the request: a DB blip
      // must degrade to "unauthorised write", not to a dead read surface.
      logger.error(
        { err: (err as Error).message, storeId: store.id },
        '[mcp agent-auth] credential lookup failed'
      );
      context.credential = 'error';
    }
  }

  if (context.grant === 'denied') {
    // Per-store escape hatch. Read through the same cached feature map the
    // `agent_checkout` gate already warmed; a failure here means "hatch
    // closed", i.e. enforcement stays on, which is the safe direction.
    const open = await featureService
      .isFeatureEnabled(store.id, AGENT_OPEN_WRITES_FEATURE)
      .catch(err => {
        logger.warn(
          { err: (err as Error).message, storeId: store.id },
          '[mcp agent-auth] open-writes feature read failed — enforcement stays on'
        );
        return false;
      });
    if (open) context.grant = 'open_writes';
  }

  return {
    token,
    clientId,
    scopes: context.grant === 'denied' ? [] : [AGENT_WRITE_SCOPE],
    extra: context,
  };
}

/** Pull our context back off whatever the SDK handed the tool handler. */
export function agentContextFrom(extra: unknown): McpAgentContext {
  const authInfo = (extra as { authInfo?: AuthInfo } | undefined)?.authInfo;
  const ctx = authInfo?.extra as McpAgentContext | undefined;
  return {
    storeSlug: ctx?.storeSlug ?? '',
    ip: ctx?.ip,
    userAgent: ctx?.userAgent,
    requestId: ctx?.requestId,
    credential: ctx?.credential ?? 'none',
    grant: ctx?.grant ?? 'denied',
  };
}

/**
 * Message an unauthorised agent gets back. It has to be actionable: an agent
 * that discovers seven tools in `llms.txt` and gets a bare 401 on two of them
 * has no way to find out why. Keep this in step with the MCP section of
 * `apps/web/src/app/llms.txt/route.ts`.
 */
export const AGENT_CREDENTIAL_REQUIRED_MESSAGE =
  'This store requires an agent credential for write tools (add_to_cart, place_order). ' +
  `Send the store's key in the \`${AGENT_KEY_HEADER}\` request header. ` +
  'Read tools (search_products, get_product, get_store_info, view_cart, get_order_status) ' +
  'need no credential. Ask the store to issue you a key — see the contact details in its llms.txt.';

/**
 * The gate. Throws inside the tool handler (which the MCP SDK converts into
 * `{ isError: true }`) so the refusal reaches the agent as a tool-level error
 * with an explanation, never as a transport-level 401 that would be
 * indistinguishable from the whole endpoint being down.
 */
export function assertAgentWrite(tool: string, extra: unknown): McpAgentContext {
  const authInfo = (extra as { authInfo?: AuthInfo } | undefined)?.authInfo;
  if (!authInfo?.scopes?.includes(AGENT_WRITE_SCOPE)) {
    throw new AppError(401, 'AGENT_CREDENTIAL_REQUIRED', AGENT_CREDENTIAL_REQUIRED_MESSAGE, {
      tool,
    });
  }
  return agentContextFrom(extra);
}

/**
 * Length cap for a caller-supplied id reaching a write tool's input schema.
 * Every id these tools take is machine-minted and short (cuid ~25, uuid 36,
 * `sess_` + 32 hex = 37), so this is orders of magnitude above any legitimate
 * value while keeping the ~10mb Express body limit out of Zod's output — and
 * therefore out of the denied-write audit row, which is written BEFORE any
 * credential check. Paired with `boundAuditDetails` below: the schema stops
 * the bulk at the door, the audit bound holds even if a schema loses its
 * `.max()` or an error message carries an unbounded payload.
 */
export const MCP_ID_MAX_CHARS = 128;

/** Max characters persisted for any ONE value inside an audit `details` blob. */
export const AUDIT_DETAIL_MAX_CHARS = 256;

/**
 * Bound every value written into `audit_logs.details`.
 *
 * The denied-write path records caller-controlled input (`productId`,
 * `cartId`) and runs BEFORE authentication — an anonymous caller hitting
 * `publicLimiter`'s 300/min/IP could otherwise stream multi-megabyte strings
 * straight into the primary Neon database, retained 90 days hot and archived
 * to R2 for 7 years. The recorded value only has to be enough to identify what
 * was attempted, so it is truncated, not dropped: the audit row keeps its
 * forensic value and loses its amplification.
 *
 * TOTAL by construction — `auditAgentWrite` is best-effort and must never
 * throw, so a value that will not serialise degrades to a marker instead of
 * propagating.
 */
function boundAuditDetails(details: Record<string, unknown>): Record<string, unknown> {
  const truncate = (s: string) =>
    s.length > AUDIT_DETAIL_MAX_CHARS ? `${s.slice(0, AUDIT_DETAIL_MAX_CHARS)}…[truncated]` : s;

  const bounded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (typeof value === 'string') {
      bounded[key] = truncate(value);
    } else if (value === null || value === undefined || typeof value !== 'object') {
      // Numbers/booleans are self-bounding; primitives pass through untouched.
      bounded[key] = value;
    } else {
      try {
        // Objects/arrays are flattened to bounded JSON — `auditLog` would
        // `JSON.parse(JSON.stringify(...))` them anyway, unbounded.
        bounded[key] = truncate(JSON.stringify(value));
      } catch {
        // Circular, or a BigInt — never worth failing an audit row over.
        bounded[key] = '[unserialisable]';
      }
    }
  }
  return bounded;
}

/**
 * Attribution for an MCP write. A REJECTED attempt is the signal we most want
 * and the one nothing recorded before: `cart.tools.ts` and `catalog.tools.ts`
 * wrote zero audit rows, and `place_order`'s single row carried no ip and no
 * user agent, so a failed agent checkout was invisible in every table and
 * every log.
 *
 * Best-effort and never-throwing — attribution must not be able to fail a
 * request, nor to turn a refusal into a 500.
 */
export async function auditAgentWrite(params: {
  store: McpStore;
  tool: string;
  outcome: 'denied' | 'failed';
  context: McpAgentContext;
  details?: Record<string, unknown>;
}): Promise<void> {
  const { store, tool, outcome, context, details } = params;
  try {
    await runInTenantContext(store.id, async () => {
      await auditLog({
        action: `agent.write.${outcome}`,
        resourceType: 'mcp_tool',
        resourceId: tool,
        storeId: store.id,
        ip: context.ip,
        userAgent: context.userAgent,
        details: {
          tool,
          source: 'agent',
          credential: context.credential,
          grant: context.grant,
          requestId: context.requestId,
          // Caller-controlled — bounded before it is persisted. Spread LAST so
          // a caller cannot overwrite the attribution fields above, and bounded
          // as a whole so the platform-supplied fields are covered too.
          ...boundAuditDetails(details ?? {}),
        },
      });
    });
  } catch (err) {
    logger.error(
      { err: (err as Error).message, storeId: store.id, tool },
      '[mcp agent-auth] write audit failed'
    );
  }
}
