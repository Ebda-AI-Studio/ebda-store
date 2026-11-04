import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { withStore } from '@ebda/database';
import { getUserState } from '../lib/definer';
import { getAccountState } from '../lib/identity-client';
import { gateRead, onAccessD1 } from '../services/platform/access-d1';
import type { McpStore } from './resolve-store';
import { AppError } from '../middleware/error-handler';
import logger from '../lib/logger';

/**
 * Credential + scope model for the MERCHANT-ADMIN MCP surface
 * (`POST /api/v1/mcp/admin/:storeSlug`).
 *
 * ## Why this is NOT `agent-auth.ts`
 *
 * The buyer endpoint's defining property is that its READS ARE ANONYMOUS —
 * that is the strategic agentic-commerce surface, and it is why nothing there
 * may reject a request at middleware level (all tools plus `initialize` and
 * `tools/list` ride one POST, so a rejecting guard would take the whole
 * surface dark).
 *
 * Nothing on the merchant surface is meant to be anonymous. That inverts the
 * constraint: here we CAN and DO reject before the MCP server is ever built,
 * which means an unauthenticated caller never learns the tool list. A
 * merchant-admin tool mounted on the buyer server would have appeared in that
 * server's `tools/list` to every anonymous caller, advertising the admin
 * surface to the world and making one `assertAgentWrite` bug the difference
 * between a shopper and a store owner.
 *
 * ## Why hashed, not encrypted
 *
 * `Store.agentApiKey` is AES-GCM encrypted because the buyer key is displayed
 * back to the merchant in the admin UI, so it must be reversible. A merchant
 * admin key is shown EXACTLY ONCE, in the mint response, and never again — so
 * a one-way SHA-256 is the correct primitive. It also keeps the secret off
 * every read path entirely, which is the concern Ruling M5 raised about
 * credential ciphertext riding out on wide `Store` reads.
 *
 * ## Lookup is by hash, not by scan
 *
 * `keyHash` is UNIQUE, so verification is a single indexed lookup on the
 * digest — never a decrypt-every-row scan. The constant-time compare that
 * follows is belt-and-braces against a timing side channel on the final
 * equality, since the index lookup itself is not constant-time.
 */

/** Header a merchant presents its admin credential in. */
export const MERCHANT_KEY_HEADER = 'x-merchant-key';

/** Human-readable prefix, so a leaked key is greppable and self-identifying. */
export const MERCHANT_KEY_PREFIX = 'ebdam_';

/**
 * Scope tiers. A key minted for reporting must not be able to delete a
 * product, so every tool declares the tier it needs and `assertScope` is the
 * single place that decides.
 */
export const MERCHANT_SCOPES = {
  read: 'merchant:read',
  write: 'merchant:write',
  destructive: 'merchant:destructive',
} as const;

export type MerchantScope = (typeof MERCHANT_SCOPES)[keyof typeof MERCHANT_SCOPES];

export const ALL_MERCHANT_SCOPES: readonly MerchantScope[] = [
  MERCHANT_SCOPES.read,
  MERCHANT_SCOPES.write,
  MERCHANT_SCOPES.destructive,
];

/**
 * Feature key gating the whole surface. In NO plan baseline, so it resolves
 * OFF for every store until a super-admin turns it on — same fail-closed
 * posture as `agent_checkout`.
 */
export const MERCHANT_MCP_FEATURE = 'merchant_mcp' as const;

/** SHA-256 hex digest. The plaintext is never stored, logged, or cached. */
export function hashMerchantKey(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

/**
 * Mints a new plaintext key. 32 random bytes (256 bits) base64url-encoded —
 * `randomBytes` is a CSPRNG; `Math.random` would be catastrophic here.
 * Returned to the caller exactly once.
 */
export function generateMerchantKey(): { plaintext: string; hash: string; prefix: string } {
  const plaintext = `${MERCHANT_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
  return {
    plaintext,
    hash: hashMerchantKey(plaintext),
    prefix: plaintext.slice(0, MERCHANT_KEY_PREFIX.length + 8), // `ebdam_` + 8 chars
  };
}

/** Identity a verified merchant key resolves to. */
export interface MerchantAuth extends AuthInfo {
  /** MerchantApiKey.id — what every audit row is attributed to. */
  keyId: string;
  /** The human this key acts as. A key is a device, not an identity. */
  userId: string;
  /**
   * The owning user's role, re-read on EVERY verification (same `ebda_user_state`
   * read as the active check). Write tools apply the SAME RBAC permission the
   * admin route applies to that user (staff cannot delete products over MCP
   * any more than in the dashboard). Never a scope substitute.
   */
  role: string;
  storeId: string;
  scopes: string[];
  /**
   * Carried from the verifying request so write tools (merchant-write.ts) can
   * attribute an audit row without threading `req` through every handler —
   * mirrors `agent-auth.ts`'s `context.ip`/`context.userAgent` for the buyer
   * surface. Never a secret; safe on the object the SDK echoes to tools.
   */
  ip: string | undefined;
  userAgent: string | undefined;
}

/**
 * Constant-time compare of two hex digests. Both are fixed-length SHA-256
 * output, so a length mismatch means the stored value is corrupt, not that an
 * attacker learned anything — refuse rather than throw from timingSafeEqual.
 */
function digestsMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ab.length !== bb.length || ab.length === 0) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Cheap, SYNCHRONOUS shape check only — no DB, no hashing, no crypto compare.
 * Lets a caller with an obviously-wrong credential (header missing, wrong
 * prefix, or too short) be rejected before ANY database work — store
 * resolution, the feature-flag lookup, or the key digest lookup below.
 * `verifyMerchantKey` still re-checks length itself and does the real
 * DB-backed verification; this is a fast-reject prefilter, not a substitute.
 * Mirrors the same posture as bypass 4's HMAC check in
 * `global-rate-limit-skip.ts`: cheap to run, safe to run before anything
 * costly, and never the thing that actually grants access.
 */
export function hasPlausibleMerchantKeyShape(req: Request): boolean {
  const presented = req.get(MERCHANT_KEY_HEADER);
  return (
    !!presented &&
    presented.startsWith(MERCHANT_KEY_PREFIX) &&
    presented.length >= MERCHANT_KEY_PREFIX.length + 8
  );
}

/**
 * Verifies the `X-Merchant-Key` header against this store.
 *
 * Throws `AppError(404, 'NOT_FOUND', 'Not found')` on EVERY failure —
 * missing header, unknown key, revoked, expired, or belonging to a different
 * store. Byte-identical to `resolveStoreBySlug`'s miss and to the feature
 * gate's refusal, so a prober cannot distinguish "no such store" from "store
 * exists, wrong key" from "store exists, feature off". Do not give any of
 * these a distinct code or message.
 *
 * A cross-store key is the case worth naming: the lookup finds the row by its
 * globally-unique hash, so the row EXISTS and is valid — it just belongs to
 * another store. Comparing `key.storeId` to the already-resolved store is what
 * stops a merchant using their own valid key against someone else's endpoint.
 */
/** Mirrors `requireStoreAccess`: owner for store_admin, a `store_staff` row for staff, nobody else. */
export async function isStoreMember(
  storeId: string,
  userId: string,
  role: string
): Promise<boolean> {
  if (await onAccessD1()) {
    const g = await gateRead(storeId, userId);
    if (!g) return false;
    if (role === 'store_admin') return g.store.ownerId === userId;
    return role === 'staff' && g.isStaff;
  }
  if (role === 'store_admin') {
    const s = await withStore(storeId, tx =>
      tx.store.findUnique({ where: { id: storeId }, select: { ownerId: true } })
    );
    return s?.ownerId === userId;
  }
  if (role === 'staff') {
    const m = await withStore(storeId, tx =>
      tx.storeStaff.findUnique({
        where: { userId_storeId: { userId, storeId } },
        select: { id: true },
      })
    );
    return !!m;
  }
  return false;
}

export async function verifyMerchantKey(req: Request, store: McpStore): Promise<MerchantAuth> {
  const presented = req.get(MERCHANT_KEY_HEADER);
  if (!presented || presented.length < MERCHANT_KEY_PREFIX.length + 8) {
    throw new AppError(404, 'NOT_FOUND', 'Not found');
  }

  const digest = hashMerchantKey(presented);
  // The store is already resolved (from the URL slug), so the key is read under
  // that store's scope. A key that belongs to ANOTHER store is simply not
  // visible here: the miss is the same 404 as an unknown key, and the
  // `wrong_store` case below stays only as defence in depth.
  const key = await withStore(store.id, tx =>
    tx.merchantApiKey.findUnique({
      where: { keyHash: digest, storeId: store.id },
      select: {
        id: true,
        storeId: true,
        userId: true,
        keyHash: true,
        scopes: true,
        revokedAt: true,
        expiresAt: true,
      },
    })
  );
  // The OWNING USER is read on every verification, not just at mint.
  //
  // A key is a device acting AS a person, and the platform's levers for
  // stopping a person — suspend, soft-delete, "sign out all devices" —
  // all act on the User row. Without this check a suspended or deleted
  // admin loses every dashboard session and keeps a fully working
  // merchant key: `admin_get_order` returns line items, customer names,
  // addresses and phones with no redaction, indefinitely if no expiry was
  // set. Phase 2 and 3 land writes on this same path, which would turn a
  // read leak into store mutation by a revoked principal.
  //
  // Read through the `ebda_user_state` definer, not a join: `users` is under
  // strict RLS, and an owner/staff row that has since left the store is not
  // visible from its scope — a join would throw on the required relation
  // instead of refusing the key.
  // After the `access` cutover the identity service is the one source for the owning account (merchant and staff accounts
  // live there); an account it does not know is no principal. Before it: the Postgres definer, unchanged.
  const keyUser = key
    ? (await onAccessD1())
      ? await getAccountState(key.userId).then(a =>
          a ? { role: a.role as string, status: a.status as string, deletedAt: null } : null
        )
      : await getUserState(key.userId)
    : null;

  // MEMBERSHIP, re-read per call with the same rule requireStoreAccess applies: a
  // store_admin must still OWN this store, staff must still hold a store_staff row.
  // Any other role (customer, super_admin) is never a member, so its key is refused.
  // A user moved/removed from the store without being deleted therefore loses the key.
  const isMember = key && keyUser ? await isStoreMember(store.id, key.userId, keyUser.role) : false;

  const now = new Date();
  const userActive = !!keyUser && keyUser.deletedAt === null && keyUser.status === 'active';
  const valid =
    !!key &&
    digestsMatch(key.keyHash, digest) &&
    key.storeId === store.id &&
    key.revokedAt === null &&
    (key.expiresAt === null || key.expiresAt > now) &&
    userActive &&
    isMember;

  if (!key || !valid) {
    // Logged at warn so a credential-stuffing run against the admin surface is
    // visible, with enough to correlate and nothing that is a secret. The
    // plaintext key never appears; `fingerprint` is a truncated digest.
    logger.warn(
      {
        storeId: store.id,
        fingerprint: digest.slice(0, 12),
        reason: !key
          ? 'unknown_key'
          : key.storeId !== store.id
            ? 'wrong_store'
            : key.revokedAt !== null
              ? 'revoked'
              : !userActive
                ? 'user_inactive'
                : !isMember
                  ? 'not_a_member'
                  : 'expired',
        ip: req.ip,
        userAgent: req.get('user-agent'),
      },
      'mcp.merchant_auth_refused'
    );
    throw new AppError(404, 'NOT_FOUND', 'Not found');
  }

  // Fire-and-forget: a failed last-used stamp must never fail the request, and
  // this is telemetry, not a gate. Awaiting it would also put a write on the
  // hot path of every read tool call.
  void withStore(store.id, tx =>
    tx.merchantApiKey.update({
      where: { id: key.id, storeId: store.id },
      data: { lastUsedAt: now },
    })
  ).catch(() => undefined);

  return {
    token: digest.slice(0, 12), // fingerprint only — never the credential
    clientId: key.id,
    keyId: key.id,
    userId: key.userId,
    role: keyUser!.role,
    storeId: key.storeId,
    scopes: key.scopes,
    ip: req.ip,
    userAgent: req.get('user-agent') ?? undefined,
  };
}

/**
 * Enforces a tool's required scope.
 *
 * Called INSIDE each tool handler on `extra.authInfo`, not as middleware —
 * the router already proved the caller holds a valid key for this store, and
 * this is the second, per-tool half: which operations that key may perform.
 *
 * Throws a plain Error (not AppError): the SDK's `CallToolRequestSchema`
 * handler catches a thrown Error and returns `{ isError: true }`, which is the
 * right shape for an agent to read. An AppError here would serialize its HTTP
 * status into a tool result, which means nothing to the caller.
 */
export function assertScope(auth: unknown, required: MerchantScope, tool: string): MerchantAuth {
  const a = auth as MerchantAuth | undefined;
  if (!a || !Array.isArray(a.scopes) || !a.scopes.includes(required)) {
    // `held` is computed defensively rather than as `a.scopes.join(...)`: this
    // branch is reached precisely when `scopes` may NOT be an array (forged,
    // absent, or a bare string), and a TypeError thrown while building the
    // refusal message would surface as an opaque tool error instead of the
    // actionable FORBIDDEN the agent needs. Found by the test for exactly that.
    const held = Array.isArray(a?.scopes) && a.scopes.length > 0 ? a.scopes.join(', ') : 'none';
    throw new Error(`FORBIDDEN: ${tool} requires the "${required}" scope; this key has [${held}].`);
  }
  return a;
}
