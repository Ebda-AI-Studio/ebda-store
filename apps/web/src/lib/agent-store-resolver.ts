import { headers } from 'next/headers';
import { API_URL } from './api';

/**
 * Resolve "which store is this request for?" for the AGENT-FACING routes —
 * `/llms.txt` and the `/.well-known/*` discovery documents.
 *
 * All three answer the same question, three levels deep, and got it right in
 * `llms.txt/route.ts` first:
 *
 *   store.force-ai.co/<slug>/…   → middleware sets `x-store-slug`
 *   wadyaljuz.com/…              → middleware sets `x-store-domain`
 *   store.force-ai.co/…          → neither: the platform itself, no store
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
  const slug = h.get('x-store-slug');
  const domain = h.get('x-store-domain');

  if (slug) {
    const store = await fetchStoreBySlug(slug);
    return store && store.status === 'active' ? store : null;
  }

  if (domain) {
    // Resolve the domain, then re-load by slug so the shape matches the
    // slug branch exactly — `/public/store/resolve` returns a thinner row.
    const resolved = await fetchStoreByHost(domain);
    const store = resolved?.slug ? ((await fetchStoreBySlug(resolved.slug)) ?? resolved) : resolved;
    // `status` is optional on the resolve payload; absent means active.
    return store && (!store.status || store.status === 'active') ? store : null;
  }

  return null;
}

/**
 * The public base URL for this store's storefront — its own domain when it has
 * one, otherwise its path under the platform host. Discovery documents must
 * quote absolute URLs, and an agent that follows a platform-rooted link for a
 * custom-domain merchant lands on a redirect at best.
 */
export function storefrontBaseUrl(store: AgentStore, requestHost: string | null): string {
  if (store.domain) return `https://${store.domain}`;
  const host = requestHost || 'store.force-ai.co';
  return `https://${host}/${store.slug}`;
}
