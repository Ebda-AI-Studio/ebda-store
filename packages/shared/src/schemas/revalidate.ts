import { z } from 'zod';

/**
 * Body of the storefront's on-demand cache purge (`POST /api/revalidate`,
 * apps/web). Deliberately shape-only: `secret` and `tags` stay `unknown` so the
 * route keeps its own answers for a wrong secret (401) and for bad tags (400) —
 * this schema's job is to refuse a body that is not an object at all, which
 * previously threw a TypeError and surfaced as a 500.
 */
export const revalidateRequestSchema = z.object({
  secret: z.unknown(),
  tags: z.unknown(),
});
