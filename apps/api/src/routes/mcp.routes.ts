import { Router, type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { publicLimiter } from '../middleware/security';
import { featureService } from '../services/feature.service';
import { resolveStoreBySlug } from '../mcp/resolve-store';
import { buildStoreMcpServer } from '../mcp/store-mcp-server';
import { AppError } from '../middleware/error-handler';

/**
 * Store-scoped MCP endpoint — stateless Streamable HTTP.
 *
 * POST /api/v1/mcp/:storeSlug — resolves the store by slug (404 on an
 * unknown/inactive/deleted slug, never default-to-first), checks the
 * `agent_checkout` feature gate (404 when disabled — fail closed, no
 * capability leak to unauthorized callers), then builds a fresh
 * McpServer + StreamableHTTPServerTransport pair for this single request
 * (`sessionIdGenerator: undefined` — no server-side session state is kept
 * between requests). Tool registration lands in Tasks 4-6.
 */
const router = Router();
router.use(publicLimiter);

async function handleMcpPost(req: Request, res: Response): Promise<void> {
  const store = await resolveStoreBySlug(req.params.storeSlug); // throws 404 on miss
  const enabled = await featureService.isFeatureEnabled(store.id, 'agent_checkout');
  // Same AppError(404, 'NOT_FOUND', 'Not found') as resolveStoreBySlug's miss
  // path — byte-identical body so a slug-prober can't distinguish
  // store-not-found from store-exists-but-gated. Do not diverge the code/message.
  if (!enabled) throw new AppError(404, 'NOT_FOUND', 'Not found'); // fail closed, no capability leak

  const server = buildStoreMcpServer(store);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

router.post('/:storeSlug', (req, res, next) => {
  handleMcpPost(req, res).catch(next);
});
router.get('/:storeSlug', (_req, res) => res.status(405).json({ error: 'Method Not Allowed' }));
router.delete('/:storeSlug', (_req, res) => res.status(405).json({ error: 'Method Not Allowed' }));

export default router;
