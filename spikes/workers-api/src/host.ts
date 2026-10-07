// Host -> tenant lookup key. Pure function, no I/O.
// Rules: <slug>.<BASE> => slug; exact custom domain => domain; everything else => null (404).
// NEVER falls back to a default store.

export const RESERVED_SLUGS = new Set([
  'app',
  'api',
  'docs',
  'help',
  'status',
  'whatsapp',
  'www',
  'admin',
]);
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export type HostKey = { slug: string; domain: null } | { slug: null; domain: string };

export function parseHost(rawHost: string | null | undefined, baseDomain: string): HostKey | null {
  if (!rawHost) return null;
  const host = rawHost.trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  if (!host || host.length > 253) return null;
  const suffix = `.${baseDomain}`;
  if (host === baseDomain) return null; // apex is the marketing site, never a store
  if (host.endsWith(suffix)) {
    const label = host.slice(0, -suffix.length);
    if (label.includes('.')) return null; // a.b.ebda.app is not a store
    if (!LABEL_RE.test(label) || RESERVED_SLUGS.has(label)) return null;
    return { slug: label, domain: null };
  }
  // Anything else is a candidate custom domain; the DB decides (exact match only).
  if (!/^[a-z0-9.-]+$/.test(host) || !host.includes('.')) return null;
  return { slug: null, domain: host };
}
