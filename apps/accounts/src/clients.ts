/**
 * Integrator clients (identity contract v1.3): a merchant's SERVER gets short access tokens with client_credentials.
 *
 * Secrets are 32 random bytes (256 bits), so a fast keyed hash is sufficient at rest: nothing can be brute-forced or looked up
 * in a rainbow table, and a slow hash would only cost CPU on every token call. We store HMAC-SHA256(CLIENT_SECRET_PEPPER, secret),
 * so a leak of the D1 database alone cannot even be used to test a guessed secret offline. Comparison is constant time and an
 * unknown client id still pays one comparison.
 */
import { b64urlEncode, nowMs, randomToken, safeEqual } from './util';
import { validateScopes } from './client-scopes';

export const SECRET_PREFIX = 'ebs_';
export const CLIENT_TOKEN_TTL_SECONDS = 600;
export const AUDIT_RETENTION_MS = 90 * 86_400_000;
export const DEFAULT_OVERLAP_HOURS = 24;
export const MAX_OVERLAP_HOURS = 168;

export class PepperMissing extends Error {}

const enc = new TextEncoder();

async function pepperKey(env: { CLIENT_SECRET_PEPPER?: string }): Promise<CryptoKey> {
  let raw: Uint8Array | undefined;
  try {
    raw = env.CLIENT_SECRET_PEPPER ? base64Decode(env.CLIENT_SECRET_PEPPER) : undefined;
  } catch {
    raw = undefined;
  }
  if (!raw || raw.length < 32) {
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'CLIENT_SECRET_PEPPER is missing or shorter than 32 bytes: integrator client endpoints are refusing every request',
      })
    );
    throw new PepperMissing('CLIENT_SECRET_PEPPER');
  }
  return crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

function base64Decode(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

export async function hmacSecret(
  env: { CLIENT_SECRET_PEPPER?: string },
  secret: string
): Promise<string> {
  const key = await pepperKey(env);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(secret)));
  return [...sig].map(b => b.toString(16).padStart(2, '0')).join('');
}

const newClientId = () =>
  'cli_' + b64urlEncode(crypto.getRandomValues(new Uint8Array(20))).slice(0, 26);
const newSecret = () => SECRET_PREFIX + randomToken();

/** /24 for IPv4, /64 for IPv6: enough to see where a client calls from, not enough to identify a person. */
export function ipPrefix(ip: string | undefined | null): string {
  if (!ip || ip === 'unknown') return 'unknown';
  if (ip.includes(':')) return ip.split(':').slice(0, 4).join(':') + '::/64';
  const p = ip.split('.');
  return p.length === 4 ? `${p[0]}.${p[1]}.${p[2]}.0/24` : 'unknown';
}

export interface ClientRow {
  id: string;
  store_id: string;
  audience: string;
  name: string;
  scopes: string;
  created_by: string;
  created_at: number;
  revoked_at: number | null;
}

type AuditEvent = 'created' | 'rotated' | 'revoked' | 'issued' | 'auth_failed';
export function audit(
  db: D1Database,
  row: {
    clientId: string;
    storeId: string;
    event: AuditEvent;
    actor?: string;
    jti?: string;
    slot?: number;
    ip?: string;
    scope?: string;
  }
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO client_audit (client_id, store_id, event, at, actor, jti, secret_slot, ip_prefix, scope) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`
    )
    .bind(
      row.clientId,
      row.storeId,
      row.event,
      nowMs(),
      row.actor ?? null,
      row.jti ?? null,
      row.slot ?? null,
      row.ip ? ipPrefix(row.ip) : null,
      row.scope ?? null
    );
}

export type CreateResult =
  | { ok: true; clientId: string; secret: string; scopes: string[] }
  | { ok: false; reason: string };

export async function createClient(
  db: D1Database,
  env: { CLIENT_SECRET_PEPPER?: string },
  input: { storeId: string; audience: string; name: string; scopes: unknown; actor: string }
): Promise<CreateResult> {
  const v = validateScopes(input.audience, input.scopes);
  if (!v.ok) return v;
  const secret = newSecret();
  const hmac = await hmacSecret(env, secret);
  const id = newClientId();
  const at = nowMs();
  await db.batch([
    db
      .prepare(
        `INSERT INTO clients (id, store_id, audience, name, scopes, created_by, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)`
      )
      .bind(id, input.storeId, input.audience, input.name, v.scopes.join(' '), input.actor, at),
    db
      .prepare(`INSERT INTO client_secrets (client_id, slot, hmac, created_at) VALUES (?1,1,?2,?3)`)
      .bind(id, hmac, at),
    audit(db, { clientId: id, storeId: input.storeId, event: 'created', actor: input.actor }),
  ]);
  return { ok: true, clientId: id, secret, scopes: v.scopes };
}

export async function getStoreClient(
  db: D1Database,
  storeId: string,
  clientId: string
): Promise<ClientRow | null> {
  return db
    .prepare(`SELECT * FROM clients WHERE id = ?1 AND store_id = ?2`)
    .bind(clientId, storeId)
    .first<ClientRow>();
}

export type RotateResult =
  | { ok: true; secret: string; slot: number; oldExpiresAt: number | null }
  | { ok: false; reason: 'NOT_FOUND' | 'REVOKED' | 'ROTATION_IN_PROGRESS' };

export async function rotateClient(
  db: D1Database,
  env: { CLIENT_SECRET_PEPPER?: string },
  storeId: string,
  clientId: string,
  actor: string,
  overlapHours: number
): Promise<RotateResult> {
  const c = await getStoreClient(db, storeId, clientId);
  if (!c) return { ok: false, reason: 'NOT_FOUND' };
  if (c.revoked_at) return { ok: false, reason: 'REVOKED' };
  const at = nowMs();
  // expired secrets are dead weight: drop them so their slot is free
  await db
    .prepare(
      `DELETE FROM client_secrets WHERE client_id = ?1 AND expires_at IS NOT NULL AND expires_at <= ?2`
    )
    .bind(clientId, at)
    .run();
  const live = (
    await db
      .prepare(`SELECT slot FROM client_secrets WHERE client_id = ?1`)
      .bind(clientId)
      .all<{ slot: number }>()
  ).results;
  if (live.length >= 2) return { ok: false, reason: 'ROTATION_IN_PROGRESS' };
  const oldSlot = live[0]?.slot;
  const slot = oldSlot === 1 ? 2 : 1;
  const secret = newSecret();
  const hmac = await hmacSecret(env, secret);
  const oldExpiresAt = overlapHours > 0 ? at + overlapHours * 3600_000 : null;
  const stmts: D1PreparedStatement[] = [];
  // (client_id, slot) is the primary key: a concurrent rotate loses the INSERT and the whole batch fails -> ROTATION_IN_PROGRESS
  if (oldSlot !== undefined) {
    stmts.push(
      overlapHours > 0
        ? db
            .prepare(`UPDATE client_secrets SET expires_at = ?3 WHERE client_id = ?1 AND slot = ?2`)
            .bind(clientId, oldSlot, oldExpiresAt)
        : db
            .prepare(`DELETE FROM client_secrets WHERE client_id = ?1 AND slot = ?2`)
            .bind(clientId, oldSlot)
    );
  }
  stmts.push(
    db
      .prepare(
        `INSERT INTO client_secrets (client_id, slot, hmac, created_at) VALUES (?1,?2,?3,?4)`
      )
      .bind(clientId, slot, hmac, at),
    audit(db, { clientId, storeId, event: 'rotated', actor, slot })
  );
  try {
    await db.batch(stmts);
  } catch {
    return { ok: false, reason: 'ROTATION_IN_PROGRESS' };
  }
  return { ok: true, secret, slot, oldExpiresAt };
}

export async function revokeClient(
  db: D1Database,
  storeId: string,
  clientId: string,
  actor: string
): Promise<'revoked' | 'already' | 'not_found'> {
  const c = await getStoreClient(db, storeId, clientId);
  if (!c) return 'not_found';
  if (c.revoked_at) return 'already';
  await db.batch([
    db
      .prepare(`UPDATE clients SET revoked_at = ?2 WHERE id = ?1 AND revoked_at IS NULL`)
      .bind(clientId, nowMs()),
    db.prepare(`DELETE FROM client_secrets WHERE client_id = ?1`).bind(clientId),
    audit(db, { clientId, storeId, event: 'revoked', actor }),
  ]);
  return 'revoked';
}

export async function listClients(db: D1Database, storeId: string) {
  const rows = (
    await db
      .prepare(
        `SELECT c.*, (SELECT max(at) FROM client_audit a WHERE a.client_id = c.id AND a.event = 'issued') AS last_used_at,
                (SELECT ip_prefix FROM client_audit a WHERE a.client_id = c.id AND a.event = 'issued' ORDER BY a.id DESC LIMIT 1) AS last_ip_prefix
           FROM clients c WHERE c.store_id = ?1 ORDER BY c.created_at`
      )
      .bind(storeId)
      .all<ClientRow & { last_used_at: number | null; last_ip_prefix: string | null }>()
  ).results;
  const secrets = (
    await db
      .prepare(
        `SELECT s.client_id, s.slot, s.created_at, s.expires_at FROM client_secrets s JOIN clients c ON c.id = s.client_id WHERE c.store_id = ?1`
      )
      .bind(storeId)
      .all<{ client_id: string; slot: number; created_at: number; expires_at: number | null }>()
  ).results;
  return rows.map(r => ({
    client_id: r.id,
    name: r.name,
    audience: r.audience,
    scopes: r.scopes.split(' '),
    created_by: r.created_by,
    created_at: r.created_at,
    revoked_at: r.revoked_at,
    last_used_at: r.last_used_at,
    last_ip_prefix: r.last_ip_prefix,
    secrets: secrets
      .filter(s => s.client_id === r.id)
      .map(s => ({ slot: s.slot, created_at: s.created_at, expires_at: s.expires_at })),
  }));
}

/** Constant-work client authentication. null = unknown client, revoked client or wrong secret (the caller cannot tell which). */
export async function authenticateClient(
  db: D1Database,
  env: { CLIENT_SECRET_PEPPER?: string },
  clientId: string,
  secret: string
): Promise<{ client: ClientRow; slot: number } | { client: null; known: ClientRow | null }> {
  const presented = await hmacSecret(env, secret);
  const client =
    clientId.length <= 64
      ? await db.prepare(`SELECT * FROM clients WHERE id = ?1`).bind(clientId).first<ClientRow>()
      : null;
  const secrets = client
    ? (
        await db
          .prepare(`SELECT slot, hmac, expires_at FROM client_secrets WHERE client_id = ?1`)
          .bind(clientId)
          .all<{ slot: number; hmac: string; expires_at: number | null }>()
      ).results
    : [];
  const at = nowMs();
  // an unknown client still pays exactly one comparison against a dummy
  const candidates = secrets.length
    ? secrets
    : [{ slot: 0, hmac: '0'.repeat(64), expires_at: null }];
  let hit = 0;
  for (const s of candidates) {
    const equal = safeEqual(presented, s.hmac);
    if (equal && s.slot && (s.expires_at === null || s.expires_at > at)) hit = s.slot;
  }
  if (client && !client.revoked_at && hit) return { client, slot: hit };
  return { client: null, known: client };
}

/** Accounts.isRevoked(cli_...): unknown, revoked or store-deleted clients are revoked. */
export async function isClientRevoked(db: D1Database, clientId: string): Promise<boolean> {
  const r = await db
    .prepare(`SELECT revoked_at FROM clients WHERE id = ?1`)
    .bind(clientId)
    .first<{ revoked_at: number | null }>();
  return !r || r.revoked_at !== null;
}

/** Store deletion: remove the store's clients, secrets and the whole trail. Idempotent. */
export async function deleteStoreClients(
  db: D1Database,
  storeId: string
): Promise<{ clients: number }> {
  const n = await db
    .prepare(`SELECT count(*) AS n FROM clients WHERE store_id = ?1`)
    .bind(storeId)
    .first<{ n: number }>();
  await db.batch([
    db
      .prepare(
        `DELETE FROM client_secrets WHERE client_id IN (SELECT id FROM clients WHERE store_id = ?1)`
      )
      .bind(storeId),
    db.prepare(`DELETE FROM client_audit WHERE store_id = ?1`).bind(storeId),
    db.prepare(`DELETE FROM clients WHERE store_id = ?1`).bind(storeId),
  ]);
  return { clients: n?.n ?? 0 };
}

/** Hourly cron: issuance rows live 90 days, lifecycle rows live as long as the store. Returns the rows removed. */
export async function pruneClientAudit(db: D1Database, now: number = nowMs()): Promise<number> {
  const r = await db
    .prepare(`DELETE FROM client_audit WHERE event = 'issued' AND at < ?1`)
    .bind(now - AUDIT_RETENTION_MS)
    .run();
  return r.meta.changes ?? 0;
}
