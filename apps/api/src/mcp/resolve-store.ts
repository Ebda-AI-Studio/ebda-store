import { prisma } from '@force/database';
import { AppError } from '../middleware/error-handler';

export interface McpStore {
  id: string;
  name: string;
  slug: string;
  currency: string;
  domain: string | null;
}

/**
 * Resolves a store by its public slug for the agent-facing MCP endpoint.
 *
 * NEVER default-to-first: an unknown/inactive/deleted slug throws a 404
 * AppError rather than falling back to any other store. See
 * feedback-tenant-resolver-throw-not-default (global memory) — tenant
 * resolvers must throw on an unresolved id, never silently substitute.
 *
 * Uses the SAME `AppError(404, 'NOT_FOUND', 'Not found')` as the route's
 * feature-gate 404 (mcp.routes.ts) so both fail-closed paths serialize to a
 * byte-identical response body — a slug-prober must not be able to
 * distinguish "store doesn't exist" from "store exists but agent_checkout is
 * off/unentitled" (capability leak). Do not give this a distinct code.
 */
export async function resolveStoreBySlug(slug: string): Promise<McpStore> {
  const store = await prisma.store.findFirst({
    where: { slug, status: 'active', deletedAt: null },
    select: { id: true, name: true, slug: true, currency: true, domain: true },
  });

  if (!store) {
    throw new AppError(404, 'NOT_FOUND', 'Not found');
  }

  return store;
}
