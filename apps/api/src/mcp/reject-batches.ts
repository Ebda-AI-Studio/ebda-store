import type { NextFunction, Request, Response } from 'express';

/**
 * Refuse every JSON-RPC BATCH (an array body) on the MCP routes, buyer (`/mcp/:slug`) and
 * merchant admin (`/mcp/admin/:slug`). Mounted first on both routers, before their limiters.
 *
 * Batches have never worked in production: the global body sanitizer used to turn an array body
 * into `{"0":...}`, which the SDK transport rejected as -32700 Parse error. Once the sanitizer
 * kept arrays (B0 Task 9), a batch of up to 100 messages (write tools, the cart-minting
 * `view_cart`) would have run for ONE limiter token. Refusing them keeps the production behaviour
 * and closes that amplification; every POST carries exactly one JSON-RPC message.
 */
export function rejectBatches(req: Request, res: Response, next: NextFunction): void {
  if (Array.isArray(req.body)) {
    res.status(400).json({
      jsonrpc: '2.0',
      error: {
        code: -32600,
        message: 'Batch requests are not supported; send one message per request.',
      },
      id: null,
    });
    return;
  }
  next();
}
