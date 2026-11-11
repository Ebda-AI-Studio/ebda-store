import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { ipKeyGenerator } from 'express-rate-limit';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { runInTenantContext, runInStoreScope, withStore } from '@ebda/database';
import { runInStoreTenantContext } from '../lib/store-scoped-read';
import { insertAuditLog } from '../lib/definer';
import { storeDb, storeRepo, type StoreWrites } from '../lib/repo-factory';
import type { McpStore } from './resolve-store';
import { encryption } from '../services/encryption.service';
import { featureService } from '../services/feature.service';
import { auditLog } from '../middleware/security';
import { AppError } from '../middleware/error-handler';
import { redis } from '../services/redis.service';
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
 * in `Store.agentApiKey` with the shared `encryption.service` scheme,
 * deliberately reusing that machinery rather than inventing a second
 * credential scheme. Two properties of this check:
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
      // `store_credentials` is store-scoped (RLS + tenant guard): read in the store's scope.
      const row = await (
        await storeDb(store.id)
      ).storeCredential.findUnique({
        where: { storeId: store.id },
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
 * Denial-audit coalescing window (#1644 / #1649, owner ruling 2026-09-25).
 *
 * Every refused write used to open its OWN `runInTenantContext` interactive
 * transaction (`basePrisma.$transaction(..., {maxWait: 10000, timeout:
 * 30000})`) — for a fully UNAUTHENTICATED caller, bounded only by
 * `publicLimiter`'s 300/min/IP. A distributed prober could hold up to 5
 * interactive transactions per second per IP on the same small Neon pool the
 * human checkout path shares, and grow `audit_logs` (90 days hot, 7-year R2
 * archive) at the same rate — the security control's own telemetry becoming
 * the DoS surface.
 *
 * A first reverted attempt (2026-09-25, see docs/RULINGS.md) coalesced to one
 * row per window WITHOUT a count, which silently dropped the repeats and
 * could defeat `classifyAgentDenials`'s thresholds (a real 50-attempt flood
 * would report as ~6 rows). This version never drops the count: the FIRST
 * attempt in a (outcome, store, ip, tool, credential) minute writes the row
 * exactly as before and remembers its id in Redis; every REPEAT in that same
 * window — which, `credential` being in the key, is an attempt the classifier
 * would bucket identically — costs a single plain, non-transactional `UPDATE`
 * of that row's `details.count` — never a new row, never a new transaction.
 *
 * What gets coalesced is decided by WHO the caller is, not by the outcome
 * (issue 2151). `agent.write.failed` (an authorised write that then threw)
 * used to be exempt on the grounds that it "requires credential possession".
 * That is false when the per-store `agent_checkout_open_writes` escape hatch
 * is on: the grant is then `open_writes` with `credential: 'none'`, so a fully
 * anonymous caller reaches `failed` trivially (`add_to_cart` with a made-up
 * productId → 404 → audited as failed) — one interactive transaction per
 * attempt, on the lever most likely to be flipped DURING an incident. So only
 * a genuinely key-bearing caller (`grant === 'credential'`) gets a
 * per-attempt `failed` row; every other `failed` is coalesced exactly like a
 * denial, under its own `agent:failed:` key so the two never share a row.
 *
 * Concurrency (issue 2150): the first attempt RESERVES the row slot
 * (`SET <key>:row pending NX`) before its insert, so a burst of concurrent
 * repeats has something to defer to instead of each opening its own
 * transaction. A repeat that finds the slot `pending` writes nothing — its
 * attempt is already in the counter, and the reserving writer re-reads the
 * counter AFTER publishing the real row id and flushes the total. (A repeat
 * can only observe `pending` before that publish, and its INCR precedes its
 * read, so the writer's re-read always includes it.)
 *
 * Fails OPEN to per-attempt rows whenever Redis cannot answer —
 * `incrementRateLimit` returns 0 when unavailable (and a Redis error mid
 * command is read the same way, issue 2141), which reads as "first" on every
 * call, so a Redis outage degrades to one row per attempt, never to a dropped
 * attempt.
 */
export const DENIAL_COALESCE_WINDOW_SECONDS = 60;

/**
 * Lifetime of a `pending` reservation. Longer than the whole
 * `runInTenantContext` envelope the reserving insert runs in (`maxWait` 10s +
 * `timeout` 30s), so a slow insert under pool contention cannot lose its slot
 * to a second writer; short enough that a reservation orphaned by a crashed
 * process stops suppressing rows well inside one watcher window.
 */
const DENIAL_ROW_PENDING_TTL_SECONDS = 45;

/** Placeholder a reserving writer holds in `<key>:row` until its row exists. */
const PENDING_ROW = 'pending';

/**
 * The address a coalescing window is keyed on. IPv6 collapses to its subnet
 * via `ipKeyGenerator` — the exact normalisation `publicLimiter`
 * (express-rate-limit's default key generator, /56) applies — so the window
 * can never be finer than the rate limit that bounds it: rotating the low
 * bits inside one prefix stays in ONE publicLimiter bucket, and must stay in
 * ONE coalescing window too, or every request is a "first" and opens its own
 * transaction (issue 2054).
 */
function denialSourceKey(ip: string | undefined): string {
  return ip ? ipKeyGenerator(ip) : 'unknown';
}

/**
 * Redis key scoping a coalescing window to exactly (outcome, store, ip, tool,
 * credential).
 *
 * `credential` is in the key because `classifyAgentDenials` PARTITIONS rows by
 * `details.credential` — `error` → p0 `platform_fault`, `invalid`/
 * `unconfigured` → p1 `integration_broken`/`credential_probing`, `none`/null →
 * `info` `anonymous_flood`. A coalescing key coarser than that partition
 * produces a row whose `count` sums attempts the classifier would have placed
 * in DIFFERENT buckets, under whichever credential the window's LAST attempt
 * happened to present: 49 `invalid` attempts followed by one key-less one
 * would collapse to `credential: 'none', count: 50` and classify as an `info`
 * anonymous flood, so the p1 it exists to catch never fires (and the same
 * mechanism could bury `error` — the p0 — under a later repeat). Keying on it
 * keeps every coalesced row homogeneous, so its `count` describes attempts
 * that all classify the same way.
 *
 * `outcome` is in the key so a `denied` and a coalesced `failed` never merge
 * into one row (they are different `action`s).
 *
 * Cardinality stays bounded: `AgentCredentialOutcome` is a 5-value enum, so
 * this is at most a 5x fan-out of an already per-(store, ip, tool) key, and in
 * practice a single caller presents one credential shape.
 */
function denialCoalesceKey(
  outcome: 'denied' | 'failed',
  storeId: string,
  tool: string,
  ip: string | undefined,
  credential: AgentCredentialOutcome
): string {
  return `agent:${outcome}:${storeId}:${denialSourceKey(ip)}:${tool}:${credential}`;
}

/**
 * Atomic INCR+EXPIRE — the same primitive `security.ts`'s rate limiters use.
 * `incrementRateLimit` already returns 0 when Redis is not connected; a
 * command that fails mid-flight (connection drop, retries exhausted) REJECTS
 * instead, and before this guard that rejection escaped to `auditAgentWrite`'s
 * outer catch and NO row was written — a Redis blip made refused writes
 * vanish from `audit_logs` entirely (issue 2141). Read it as 0 ("first"), the
 * documented fail-open.
 */
async function countAttempt(key: string): Promise<number> {
  try {
    return await redis.incrementRateLimit(key, DENIAL_COALESCE_WINDOW_SECONDS);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, '[mcp agent-auth] denial counter failed');
    return 0;
  }
}

/** The window counter's current value, or null when Redis cannot answer. */
async function readAttemptCount(key: string): Promise<number | null> {
  if (!redis.isAvailable()) return null;
  try {
    return await redis.getRateLimitCount(key);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, '[mcp agent-auth] denial counter read failed');
    return null;
  }
}

/**
 * Remember which audit row the FIRST attempt in a window landed on, so a
 * repeat can bump ITS count instead of writing a new row. Best-effort: losing
 * this (Redis restart mid-window, a TTL race) only means the next repeat
 * falls back to writing its own fresh row — never a crash, never a dropped
 * attempt. Guards with `isAvailable()` first (not just a null check) so a
 * client that exists but is mid-reconnect fails fast instead of queuing.
 *
 * The cached value is `<rowId>|<base>`, NOT a bare row id, because the counter
 * and this pointer have DIFFERENT lifetimes: `incrementRateLimit` issues
 * `INCR` + `EXPIRE` on every call, so the counter slides and never expires
 * while attempts keep arriving inside the window, whereas this key carries a
 * fixed `EX` from the moment its row was created. Under a sustained flood the
 * pointer therefore expires with the counter still climbing, and the row that
 * replaces it must NOT be stamped with the cumulative counter — that is the
 * same attempts counted twice (300, then 600, then 900 … for one steady
 * prober), which both false-pages the p0/p1 thresholds and misreports the
 * volume the operator sizes the incident from. `base` is the counter value the
 * row started from, so every flush writes `attemptsInWindow - base` — the
 * attempts belonging to THAT row — and the rows of a flood sum to the real
 * attempt count instead of a multiple of it.
 */
async function rememberDenialRow(key: string, value: string): Promise<boolean> {
  if (!redis.isAvailable()) return false;
  try {
    const client = redis.getClient();
    if (!client) return false;
    await client.set(`${key}:row`, value, 'EX', DENIAL_COALESCE_WINDOW_SECONDS);
    return true;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, '[mcp agent-auth] denial-row cache set failed');
    return false;
  }
}

async function recallDenialRow(key: string): Promise<string | null> {
  if (!redis.isAvailable()) return null;
  try {
    return (await redis.getClient()?.get(`${key}:row`)) ?? null;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, '[mcp agent-auth] denial-row cache get failed');
    return null;
  }
}

/**
 * Claim the window's row slot before inserting. `reserved` = this call owns
 * the insert; `held` = another writer got there first (pending or real);
 * `unavailable` = Redis cannot arbitrate, so the caller writes its own row
 * (fail-open, per-attempt).
 */
async function reserveDenialRow(key: string): Promise<'reserved' | 'held' | 'unavailable'> {
  if (!redis.isAvailable()) return 'unavailable';
  try {
    const client = redis.getClient();
    if (!client) return 'unavailable';
    const result = await client.set(
      `${key}:row`,
      PENDING_ROW,
      'EX',
      DENIAL_ROW_PENDING_TTL_SECONDS,
      'NX'
    );
    return result === 'OK' ? 'reserved' : 'held';
  } catch (err) {
    logger.warn({ err: (err as Error).message }, '[mcp agent-auth] denial-row reserve failed');
    return 'unavailable';
  }
}

/** Drop a reservation whose insert failed, so the window is not suppressed. */
async function releaseDenialRow(key: string): Promise<void> {
  if (!redis.isAvailable()) return;
  try {
    const client = redis.getClient();
    if ((await client?.get(`${key}:row`)) === PENDING_ROW) await client?.del(`${key}:row`);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, '[mcp agent-auth] denial-row release failed');
  }
}

function encodeDenialRow(rowId: string, base: number): string {
  return `${rowId}|${base}`;
}

/**
 * Parse `<rowId>|<base>`. A value with no separator is a pointer written by a
 * previous deploy (bare row id) — read it as `base: 0`, i.e. exactly the old
 * behaviour, for the ≤60s such a value can still exist. Anything malformed
 * (or a negative/NaN base) is treated as no pointer at all, which self-heals
 * into a fresh row rather than corrupting a count. `pending` is handled by the
 * caller before this is reached.
 */
function decodeDenialRow(raw: string | null): { rowId: string; base: number } | null {
  if (!raw || raw === PENDING_ROW) return null;
  const sep = raw.lastIndexOf('|');
  if (sep < 0) return { rowId: raw, base: 0 };
  const rowId = raw.slice(0, sep);
  const base = Number(raw.slice(sep + 1));
  if (!rowId || !Number.isInteger(base) || base < 0) return null;
  return { rowId, base };
}

/**
 * Write the FIRST audit row of a coalescing window. Mirrors `auditLog`'s two
 * effects (the dev-mode `[AUDIT]` log line + the `audit_logs` insert) rather
 * than calling it directly, because this is the one caller that needs the
 * created row's id back to remember it for the repeats that follow.
 */
async function createCoalescedAuditRow(
  action: string,
  store: McpStore,
  tool: string,
  context: McpAgentContext,
  detailsRecord: Record<string, unknown>
): Promise<string | undefined> {
  if (process.env.NODE_ENV !== 'production') {
    logger.info(
      {
        audit: {
          action,
          storeId: store.id,
          resourceType: 'mcp_tool',
          resourceId: tool,
          ip: context.ip,
          userAgent: context.userAgent,
          details: detailsRecord,
        },
      },
      '[AUDIT]'
    );
  }
  let rowId: string | undefined;
  await inAuditScope(store.id, async w => {
    const row = await w.auditLog.create({
      data: {
        action,
        resourceType: 'mcp_tool',
        resourceId: tool,
        storeId: store.id,
        ipAddress: context.ip,
        userAgent: context.userAgent,
        details: JSON.parse(JSON.stringify(detailsRecord)),
      },
    });
    rowId = row.id;
  });
  return rowId;
}

/**
 * The audit table of a store lives where the store does (NEON-ZERO N-10d): its Durable Object, or Postgres inside a
 * store-scoped context. A DO store never opens a Postgres transaction for it.
 */
async function inAuditScope<T>(storeId: string, fn: (w: StoreWrites) => Promise<T>): Promise<T> {
  const repo = await storeRepo(storeId);
  if (repo.backend === 'do') return fn(repo.writer);
  return runInTenantContext(storeId, () => fn(repo.writer));
}

/**
 * Flush a window's count onto its row. A single, non-transactional UPDATE by
 * primary key, inside `runInStoreScope` (one short store-scoped statement, no
 * interactive transaction held open). Returns false when the update failed.
 */
async function flushCount(
  rowId: string,
  baseDetails: Record<string, unknown>,
  count: number,
  store: McpStore,
  tool: string
): Promise<boolean> {
  try {
    // One short store-scoped statement (strict RLS: an unscoped UPDATE matches no row).
    const repo = await storeRepo(store.id);
    const details = JSON.parse(JSON.stringify({ ...baseDetails, count }));
    if (repo.backend === 'do') {
      // the DO audit trail has no generic update: one named procedure, scoped to this row and store
      await repo.writer.$proc('auditSetDetails', { id: rowId, storeId: store.id, details });
    } else {
      await runInStoreScope(store.id, () =>
        repo.writer.auditLog.update({ where: { id: rowId, storeId: store.id }, data: { details } })
      );
    }
    return true;
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, storeId: store.id, tool },
      '[mcp agent-auth] denial-count flush failed — writing a fresh row instead'
    );
    return false;
  }
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
  const action = `agent.write.${outcome}`;
  try {
    // Caller-controlled — bounded before it is persisted. Spread LAST so a
    // caller cannot overwrite the attribution fields above it, and bounded as
    // a whole so the platform-supplied fields are covered too.
    const baseDetails: Record<string, unknown> = {
      tool,
      source: 'agent',
      credential: context.credential,
      grant: context.grant,
      requestId: context.requestId,
      ...boundAuditDetails(details ?? {}),
    };

    if (outcome === 'failed' && context.grant === 'credential') {
      // A key-bearing caller's failed write — bounded by who holds a key, so
      // one row per attempt. See DENIAL_COALESCE_WINDOW_SECONDS (issue 2151).
      await runInStoreTenantContext(store.id, async () => {
        await auditLog({
          action,
          resourceType: 'mcp_tool',
          resourceId: tool,
          storeId: store.id,
          ip: context.ip,
          userAgent: context.userAgent,
          details: baseDetails,
        });
      });
      return;
    }

    const dedupeKey = denialCoalesceKey(outcome, store.id, tool, context.ip, context.credential);
    // 0 when Redis cannot answer, which the checks below read as "first" too,
    // so a Redis outage falls back to one row per attempt.
    const attemptsInWindow = await countAttempt(dedupeKey);

    const reservation = await reserveDenialRow(dedupeKey);
    // Every attempt tries to claim the window's row slot (SET NX). Only the
    // first in a window wins; every repeat finds it HELD and joins that row.
    if (reservation === 'held') {
      const raw = await recallDenialRow(dedupeKey);
      // The window's first writer is still inserting. This attempt is already
      // in the counter, and that writer re-reads the counter after it
      // publishes the row id — so it carries this one. Writing nothing here
      // is what keeps a CONCURRENT burst to one transaction (issue 2150).
      if (raw === PENDING_ROW) return;
      const cached = decodeDenialRow(raw);
      // Attempts belonging to THIS row, never the raw window counter (which
      // slides across rows — see `rememberDenialRow`). Clamped at 1 for the
      // case where the counter expired/was evicted under the pointer, which
      // would otherwise make the delta negative.
      if (
        cached &&
        (await flushCount(
          cached.rowId,
          baseDetails,
          Math.max(attemptsInWindow - cached.base, 1),
          store,
          tool
        ))
      ) {
        return;
      }
      // No usable row id (Redis restarted mid-window, a TTL race, or the
      // update above failed) — fall through and write a durable row rather
      // than silently dropping the attempt; it starts a new coalescing window.
    }

    // This row starts a window at the counter's CURRENT value: its count is 1
    // (this attempt) and every later flush to it writes the delta from here.
    // Stamping it with `attemptsInWindow` instead would re-count every attempt
    // the expired window already recorded on its own row.
    const base = Math.max(attemptsInWindow - 1, 0);
    let rowId: string | undefined;
    let insertError: unknown;
    try {
      rowId = await createCoalescedAuditRow(action, store, tool, context, {
        ...baseDetails,
        count: 1,
      });
    } catch (err) {
      insertError = err;
    }
    if (!rowId) {
      if (reservation === 'reserved') await releaseDenialRow(dedupeKey);
      // The reserving insert failed (pool timeout / P2028 — most likely DURING
      // a flood). Every repeat that saw `pending` returned having written
      // nothing, so without this the whole burst would be invisible to the
      // denial watcher (PR 2301 audit). Record it on one plain,
      // non-transactional insert — no interactive tenant transaction, the same
      // way the repeat UPDATE runs — carrying every attempt the counter saw.
      logger.warn(
        { err: (insertError as Error | undefined)?.message, storeId: store.id, tool },
        '[mcp agent-auth] coalesced audit insert failed — writing an unscoped row instead'
      );
      const now = reservation === 'reserved' ? await readAttemptCount(dedupeKey) : null;
      await insertAuditLog({
        action,
        resourceType: 'mcp_tool',
        resourceId: tool,
        storeId: store.id,
        ip: context.ip,
        userAgent: context.userAgent,
        details: { ...baseDetails, count: now !== null ? Math.max(now - base, 1) : 1 },
      });
      return;
    }
    const published = await rememberDenialRow(dedupeKey, encodeDenialRow(rowId, base));
    // Issue 2330: a failed publish left `<key>:row` at `pending` for its whole
    // TTL, and every repeat that reads `pending` writes NOTHING (it trusts this
    // writer to flush) — so one Redis blip turned a flood into `count: 1`.
    // Drop the reservation instead: the window falls back to per-attempt rows
    // (the documented fail-open), and the flush below still carries every
    // repeat that already saw `pending`.
    if (!published && reservation === 'reserved') await releaseDenialRow(dedupeKey);

    // Carry every repeat that saw our reservation while we were inserting.
    // Read AFTER the pointer is published: any attempt that observed `pending`
    // incremented the counter before this read.
    if (reservation === 'reserved' && attemptsInWindow > 0) {
      const now = await readAttemptCount(dedupeKey);
      if (now !== null && now - base > 1) {
        await flushCount(rowId, { ...baseDetails }, now - base, store, tool);
      }
    }
  } catch (err) {
    logger.error(
      { err: (err as Error).message, storeId: store.id, tool },
      '[mcp agent-auth] write audit failed'
    );
  }
}
