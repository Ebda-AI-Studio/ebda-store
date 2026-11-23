import type { NextFunction, Request, Response } from 'express';
import { bodyShapeViolation } from '@ebda/shared/request-guard';

/**
 * Size guard for the MCP routes, buyer (`/mcp/:slug`) and merchant admin (`/mcp/admin/:slug`),
 * mounted right after `rejectBatches`, BEFORE the SDK parses the message with zod.
 *
 * Why (Ruling ITEST-11, GHSA-mrhx-c7xc-m3w5): zod's array parser keeps one issue object per failing
 * element with no cap, so a large array in a request that fails validation can exhaust memory. The
 * app-wide JSON parser allows 10 MB, far more than any MCP message needs: every tool takes scalars and
 * small objects (no tool input is an array at all), and a batch is refused before this runs. So the body
 * is capped in bytes, and any array, depth or node count beyond what a real message has is refused
 * with the same JSON-RPC envelope `rejectBatches` uses. Patched zod 4.6.7 is the fix; this is the
 * second layer at our boundary.
 */
export const MCP_MAX_BODY_BYTES = 256 * 1024;
export const MCP_MAX_ARRAY_LENGTH = 100;
export const MCP_MAX_DEPTH = 12;
export const MCP_MAX_NODES = 5000;

/** The first limit a parsed JSON value exceeds, or null (shared walker, vendored `@ebda/shared/request-guard`). */
export function mcpBodyViolation(body: unknown): string | null {
  return bodyShapeViolation(body, {
    maxArrayLength: MCP_MAX_ARRAY_LENGTH,
    maxDepth: MCP_MAX_DEPTH,
    maxNodes: MCP_MAX_NODES,
  });
}

function refuse(res: Response, status: number, message: string): void {
  res.status(status).json({ jsonrpc: '2.0', error: { code: -32600, message }, id: null });
}

export function mcpRequestGuard(req: Request, res: Response, next: NextFunction): void {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MCP_MAX_BODY_BYTES) {
    refuse(res, 413, 'Request body too large.');
    return;
  }
  const violation = mcpBodyViolation(req.body);
  if (violation) {
    refuse(res, 400, `Request refused: ${violation}.`);
    return;
  }
  next();
}
