import { headers } from 'next/headers';
import { API_URL } from './api';
import { storefrontOrigin } from '@force/shared';

/**
 * Resolve "which store is this request for?" for the AGENT-FACING routes —
 * `/llms.txt` and the `/.well-known/*` discovery documents.
 *
 * All three answer the same question, three levels deep, and got it right in
 * `llms.txt/route.ts` first:
 *
 *   <slug>.ebda.app/…   → middleware sets `x-store-domain` to the host
 *   demo-shop.example/…     → middleware sets `x-store-domain` to the host
 *   ebda.app/…          → neither: the platform itself, no store
 *
 * Extracted so a new discovery document cannot re-derive it slightly
 * differently. The custom-domain branch in particular is easy to miss — omit
 * it and every merchant on their own domain silently falls through to the
 * platform answer, which is what happened to `llms.txt` once already.
 */

/** Only the fields the agent-facing routes actually read. */
export interface AgentStore {
  id: string;
  name: string;
  nameAr?: string;
  slug: string;
  description?: string;
  descriptionAr?: string;
  email?: string;
  phone?: string;
  domain?: string;
  currency?: string;
  status?: string;
  enabledFeatures?: string[];
}

function withFeatures(json: unknown): AgentStore | null {
  const j = json as { data?: { store?: AgentStore; enabledFeatures?: unknown } } | null;
  const store = j?.data?.store ?? null;
  if (!store) return null;
  return {
    ...store,
    enabledFeatures: Array.isArray(j?.data?.enabledFeatures)
      ? (j!.data!.enabledFeatures as string[])
      : undefined,
  };
}

export async function fetchStoreBySlug(slug: string): Promise<AgentStore | null> {
  try {
    const res = await fetch(`${API_URL}/public/stores/${encodeURIComponent(slug)}`, {
      next: { revalidate: 600 },
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) return null;
    return withFeatures(await res.json());
  } catch {
    return null;
  }
}

export async function fetchStoreByHost(host: string): Promise<AgentStore | null> {
  if (!host) return null;
  try {
    const res = await fetch(`${API_URL}/public/store/resolve`, {
      next: { revalidate: 600 },
      headers: { 'Content-Type': 'application/json', 'x-store-domain': host },
    });
    if (!res.ok) return null;
    return withFeatures(await res.json());
  } catch {
    return null;
  }
}

/**
 * The store this request is for, or `null` for a platform-level request.
 *
 * A store that exists but is not `active` resolves to `null`: a discovery
 * document is a promise that an agent can transact here, and a suspended store
 * cannot. Returning it would advertise a capability that 404s on first use.
 */
export async function resolveAgentStore(): Promise<AgentStore | null> {
  const h = await headers();
  const domain = h.get('x-store-domain');

  if (domain) {
    // Resolve the host (`<slug>.ebda.app` or custom domain), then re-load by
    // slug so the shape matches the by-slug payload — `/public/store/resolve`
    // returns a thinner row.
    const resolved = await fetchStoreByHost(domain);
    const store = resolved?.slug ? ((await fetchStoreBySlug(resolved.slug)) ?? resolved) : resolved;
    // `status` is optional on the resolve payload; absent means active.
    return store && (!store.status || store.status === 'active') ? store : null;
  }

  return null;
}

/**
 * Retired guard: true only if a request carries `x-store-slug-source: cookie`.
 *
 * Store identity comes from the Host alone now — no cookie or path ever names a
 * store — and middleware.ts strips any client-supplied `x-store-slug*` header
 * and never sets it, so this returns false for every real request. It stays as
 * a defensive second line: should a future change reintroduce a non-URL
 * identity source and mark it with this header, the agent documents degrade to
 * `private` instead of a cross-tenant shared-cache entry. Cloudflare's cache
 * ignores `Vary` outside its Enterprise-only feature (apps/api/src/lib/edge-cache.ts),
 * which is why the guard is on the response, not on a `Vary`.
 */
export async function resolvedViaCookie(): Promise<boolean> {
  const h = await headers();
  return h.get('x-store-slug-source') === 'cookie';
}

/**
 * The public base URL for this store's storefront — its own domain when it has
 * one, otherwise its `<slug>.ebda.app` origin. Discovery documents must quote
 * absolute URLs; the answer is a pure function of the store, never of a
 * request header.
 */
export function storefrontBaseUrl(store: AgentStore): string {
  return storefrontOrigin(store);
}
