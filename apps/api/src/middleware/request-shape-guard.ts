import type { NextFunction, Request, Response } from 'express';
import { bodyShapeViolation, type BodyShapeLimits } from '@ebda/shared/request-guard';

/**
 * API-wide guard, mounted right after the JSON/urlencoded parsers and before any route or schema
 * (Ruling ITEST-11). The MCP routers add a much stricter one (`mcp/request-guard.ts`).
 *
 * Limits are set above anything a real client sends: the largest declared array in a route schema is
 * 2,000 elements, a page-builder document is a few hundred nodes, and the byte cap equals the JSON
 * parser's own limit (`API_JSON_BODY_LIMIT_BYTES`, used by `express.json` in app.ts).
 */
export const API_JSON_BODY_LIMIT_BYTES = 10 * 1024 * 1024;
export const API_BODY_LIMITS: BodyShapeLimits = {
  maxArrayLength: 10_000,
  maxDepth: 32,
  maxNodes: 250_000,
};

function refuse(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ success: false, error: { code, message } });
}

export function requestShapeGuard(req: Request, res: Response, next: NextFunction): void {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > API_JSON_BODY_LIMIT_BYTES) {
    refuse(res, 413, 'PAYLOAD_TOO_LARGE', 'Request body too large.');
    return;
  }
  const body: unknown = req.body;
  // Raw webhook bodies are Buffers and never reach a schema as JSON here; nothing to walk.
  if (body === undefined || body === null || typeof body !== 'object' || Buffer.isBuffer(body)) {
    next();
    return;
  }
  const violation = bodyShapeViolation(body, API_BODY_LIMITS);
  if (violation) {
    refuse(res, 400, 'REQUEST_TOO_COMPLEX', `Request refused: ${violation}.`);
    return;
  }
  next();
}
