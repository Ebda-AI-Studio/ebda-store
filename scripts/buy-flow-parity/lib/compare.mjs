/**
 * Normalisation + field-level diff.
 *
 * Normalisation replaces only values that are random BY CONSTRUCTION and would
 * differ between two runs of the SAME code: generated UUIDs, order numbers,
 * timestamps, JWTs / CSRF tokens, the hash tail of the Paymob merchant reference and the
 * loopback port of each API instance. Seeded ids become `<seed:...>` (the fixture is
 * deterministic), generated ids become `<id:N>` numbered by first appearance —
 * so "the same order id is referenced in the same places" is still compared.
 * No money field, status, amount or key is ever normalised.
 */

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ORDER_NO_RE = /\bORD-[0-9A-Z]{4,}-[0-9A-Z]{3,}\b/g;
const TS_RE = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g;
const JWT_RE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
// Build-location of each ref's temporary worktree (differs per sha by design).
// The Paymob merchant reference is `<orderNo>-<10 hex>`: the tail is a hash of the idempotency
// key, which holds the (random) order id. Random by construction, like the id itself.
const REF_HASH_RE = /(<orderNo:\d+>)-[0-9a-f]{10}\b/g;
// Each API instance listens on its own loopback port, and the callback URLs it sends name it.
const LOOPBACK_PORT_RE = /(https?:\/\/127\.0\.0\.1):\d+/g;
const WORKTREE_RE = /[^\s"'`]*fwb-buy-flow-parity\/wt-[0-9a-f]+/g;
const SECRET_KEYS = new Set([
  'csrfToken',
  'accessToken',
  'refreshToken',
  'token',
  'challengeToken',
  'signature',
]);

export function makeNormalizer(seedIds) {
  const ids = new Map();
  const orderNos = new Map();
  const mapId = raw => {
    const id = raw.toLowerCase();
    if (seedIds[id]) return `<seed:${seedIds[id]}>`;
    if (!ids.has(id)) ids.set(id, `<id:${ids.size + 1}>`);
    return ids.get(id);
  };
  const mapOrderNo = raw => {
    if (!orderNos.has(raw)) orderNos.set(raw, `<orderNo:${orderNos.size + 1}>`);
    return orderNos.get(raw);
  };
  const str = s =>
    s
      .replace(WORKTREE_RE, '<worktree>')
      .replace(JWT_RE, '<jwt>')
      .replace(ORDER_NO_RE, mapOrderNo)
      .replace(REF_HASH_RE, '$1-<hash>')
      .replace(LOOPBACK_PORT_RE, '$1:<port>')
      .replace(UUID_RE, mapId)
      .replace(TS_RE, '<ts>');

  const walk = (v, key) => {
    if (v === null || v === undefined) return v ?? null;
    if (typeof v === 'string') {
      if (SECRET_KEYS.has(key) && v.length > 0) return '<secret>';
      return str(v);
    }
    if (Array.isArray(v)) return v.map(x => walk(x));
    if (typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v).sort()) out[k] = walk(v[k], k);
      return out;
    }
    return v;
  };
  return walk;
}

/** Deep diff → [{ path, kind: changed|added|removed, base, head }]. */
export function diff(base, head, path = '') {
  const out = [];
  const isObj = x => x !== null && typeof x === 'object';
  if (Array.isArray(base) && Array.isArray(head)) {
    const n = Math.max(base.length, head.length);
    for (let i = 0; i < n; i++) {
      const p = `${path}[${i}]`;
      if (i >= base.length) out.push({ path: p, kind: 'added', base: undefined, head: head[i] });
      else if (i >= head.length)
        out.push({ path: p, kind: 'removed', base: base[i], head: undefined });
      else out.push(...diff(base[i], head[i], p));
    }
    return out;
  }
  if (isObj(base) && isObj(head) && !Array.isArray(base) && !Array.isArray(head)) {
    const keys = new Set([...Object.keys(base), ...Object.keys(head)]);
    for (const k of [...keys].sort()) {
      const p = path ? `${path}.${k}` : k;
      if (!(k in base)) out.push({ path: p, kind: 'added', base: undefined, head: head[k] });
      else if (!(k in head)) out.push({ path: p, kind: 'removed', base: base[k], head: undefined });
      else out.push(...diff(base[k], head[k], p));
    }
    return out;
  }
  if (JSON.stringify(base) !== JSON.stringify(head))
    out.push({ path, kind: 'changed', base, head });
  return out;
}

/**
 * `--allow <scenario>:<pathPrefix>=<reason>` — scenario may be `*`. A diff is
 * allowed only if its path starts with the prefix. The reason is mandatory and
 * printed next to every diff it waves through.
 */
export function parseAllows(list) {
  return list.map(spec => {
    const eq = spec.indexOf('=');
    if (eq < 0 || !spec.slice(eq + 1).trim()) {
      throw new Error(
        `--allow "${spec}" needs an explicit reason: --allow <scenario>:<path>=<reason>`
      );
    }
    const target = spec.slice(0, eq);
    const colon = target.indexOf(':');
    if (colon < 0) throw new Error(`--allow "${spec}" must be <scenario>:<path>=<reason>`);
    return {
      scenario: target.slice(0, colon),
      prefix: target.slice(colon + 1),
      reason: spec.slice(eq + 1).trim(),
    };
  });
}

export function allowFor(allows, scenario, path) {
  return (
    allows.find(
      a => (a.scenario === '*' || a.scenario === scenario) && path.startsWith(a.prefix)
    ) ?? null
  );
}
