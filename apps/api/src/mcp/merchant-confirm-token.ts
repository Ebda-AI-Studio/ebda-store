import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { derivedSecret } from '../lib/derived-secret';
import { redis } from '../services/redis.service';
import logger from '../lib/logger';

/**
 * Confirm-token round-trip for DESTRUCTIVE merchant-MCP tools (Ahmad,
 * 2026-10-10, requirement 2): a destructive tool's first call returns a
 * token instead of acting; the agent must call the SAME tool again with that
 * token to execute. This is the "are you sure" the admin dashboard gets from
 * a confirm dialog — an LLM has no dialog, so the round-trip IS the dialog.
 *
 * ## Signed + single-use
 *
 * The token is a self-contained HMAC (same shape as `lib/review-token.ts`,
 * derived-secret, not a JWT — rotating JWT_SECRET must not invalidate an
 * in-flight confirmation). Stateless verification alone is NOT replay
 * protection: a token that rides an LLM transcript could be re-sent inside
 * its TTL to repeat a destructive action. So the EXECUTING call additionally
 * claims the token's `jti` with an atomic Redis `SET NX EX` (the same pattern
 * as `signup-abuse.service.ts` `consumeToken`, and `agent-auth.ts`'s row
 * reservation). "Used" = that key exists. Unlike those two (fail-open,
 * availability over strictness) this FAILS CLOSED: if Redis cannot arbitrate,
 * a destructive action is refused — a replayed refund is worse than a retry.
 * (Under NODE_ENV=test with no Redis a process-local set stands in, mirroring
 * `FeatureService.readFromCache`'s test carve-out.)
 *
 * ## What the token binds
 *
 * `tool` + `storeId` + `keyId` + `userId` (actor) + `argsHash` + a random
 * `jti` + an embedded expiry — so a token minted for
 * "cancel order A" cannot be replayed to cancel order B, cannot cross a
 * store boundary even if two stores share a tool name, and cannot be used by
 * a different merchant key than the one that requested it. `argsHash` is a
 * canonical hash of the SAME args object the tool will re-validate on the
 * confirm call — if the agent changes the orderId between the two calls, the
 * hash no longer matches and the confirm is refused, not silently redirected
 * to the new target.
 */

/** 2 minutes — long enough for an agent's next turn, short enough that a
 *  leaked token (it rides a third-party LLM transcript) is useless by the
 *  time anyone could replay it. */
export const CONFIRM_TOKEN_TTL_MS = 2 * 60 * 1000;

export interface ConfirmTokenSubject {
  tool: string;
  storeId: string;
  keyId: string;
  /** The human the key acts as — the actor the confirmation was shown to. */
  userId: string;
  argsHash: string;
}

interface ConfirmTokenPayload extends ConfirmTokenSubject {
  /** Unix ms this token stops verifying. */
  exp: number;
  /** Random nonce — the single-use key. */
  jti: string;
}

function signingKey(): Buffer {
  return derivedSecret('ebda:mcp-confirm-mac:v1');
}

function mac(key: Buffer, body: string): string {
  return createHmac('sha256', key).update(body).digest('hex');
}

/** Deterministic JSON: object keys sorted at EVERY depth (arrays keep order). */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = canonicalize(v);
    }
    return out;
  }
  return value;
}

/**
 * Canonical hash of a tool's input args — same values in any key order, at any
 * nesting depth, hash identically; `undefined` keys are ignored. Not secret,
 * only the binding the HMAC above protects.
 */
export function hashConfirmArgs(args: Record<string, unknown>): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(args)))
    .digest('hex');
}

/** Mints a confirm token for a destructive call. Returned to the agent in the
 *  tool's "confirmation required" response; never logged or persisted. */
export function signConfirmToken(subject: ConfirmTokenSubject): string {
  const payload: ConfirmTokenPayload = {
    ...subject,
    exp: Date.now() + CONFIRM_TOKEN_TTL_MS,
    jti: randomUUID(),
  };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = mac(signingKey(), body);
  return `${body}.${signature}`;
}

/**
 * Verifies a presented token against the EXACT subject of the current call.
 * Any mismatch — wrong tool, wrong store, wrong key, different args, expired,
 * tampered, or malformed — returns false. Never throws: a malformed token is
 * just an unconfirmed call, not a server error.
 */
export function verifyConfirmToken(token: string, expected: ConfirmTokenSubject): boolean {
  if (typeof token !== 'string' || !token.includes('.')) return false;
  const [body, signature] = token.split('.', 2);
  if (!body || !signature) return false;

  const expectedSig = mac(signingKey(), body);
  const given = Buffer.from(signature, 'hex');
  const want = Buffer.from(expectedSig, 'hex');
  if (given.length !== want.length || given.length === 0 || !timingSafeEqual(given, want)) {
    return false;
  }

  let payload: ConfirmTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return false;
  }
  if (typeof payload.exp !== 'number' || Date.now() > payload.exp) return false;
  if (typeof payload.jti !== 'string' || payload.jti.length === 0) return false;

  return (
    payload.tool === expected.tool &&
    payload.storeId === expected.storeId &&
    payload.keyId === expected.keyId &&
    payload.userId === expected.userId &&
    payload.argsHash === expected.argsHash
  );
}

const USED_KEY_PREFIX = 'mcp:confirm-used:';
/** TTL outlives the token's own expiry so a late replay is still caught. */
const USED_KEY_TTL_SECONDS = Math.ceil(CONFIRM_TOKEN_TTL_MS / 1000) + 60;
/** Test-only stand-in when Redis is absent (see header). jti -> expiry ms. */
const testUsed = new Map<string, number>();

/**
 * Atomically claims a (verified) token for its one execution. Returns true for
 * the FIRST claim, false for any replay. Throws when the claim store cannot
 * arbitrate (fail closed): the caller must refuse the destructive action.
 * Call ONLY after `verifyConfirmToken` returned true.
 */
export async function consumeConfirmToken(token: string): Promise<boolean> {
  const body = token.split('.', 1)[0];
  let jti: string;
  try {
    jti = (JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as ConfirmTokenPayload).jti;
  } catch {
    return false;
  }
  if (typeof jti !== 'string' || !jti) return false;

  const client = redis.getClient();
  if (client && redis.isAvailable()) {
    try {
      const res = await client.set(
        `${USED_KEY_PREFIX}${jti}`,
        '1',
        'EX',
        USED_KEY_TTL_SECONDS,
        'NX'
      );
      return res === 'OK';
    } catch (err) {
      logger.error({ err }, '[mcp confirm] single-use claim failed; refusing (fail closed)');
      throw new Error(
        'UNAVAILABLE: could not record the confirmation; the action was NOT performed. Retry.'
      );
    }
  }
  if (process.env.NODE_ENV === 'test') {
    const now = Date.now();
    for (const [k, exp] of testUsed) if (exp < now) testUsed.delete(k);
    if (testUsed.has(jti)) return false;
    testUsed.set(jti, now + USED_KEY_TTL_SECONDS * 1000);
    return true;
  }
  throw new Error(
    'UNAVAILABLE: confirmation store is offline; the action was NOT performed. Retry shortly.'
  );
}
