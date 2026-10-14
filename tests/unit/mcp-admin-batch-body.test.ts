/**
 * B0 Task 9 fix round 1: a JSON-RPC batch (top-level array body) must reach the MCP admin route
 * as an ARRAY after the global sanitizer, or `rejectWriteBatches` (Array.isArray(req.body)) can
 * never fire and a batch of N write calls spends one write-limiter token.
 */
import { describe, it, expect } from 'vitest';
import type { Request, Response } from 'express';
import { sanitizeInput } from '@api/middleware/security';
import { rejectWriteBatches } from '@api/routes/mcp-admin.routes';
import { ADMIN_WRITE_TOOL_NAMES } from '@api/mcp/tools/admin-write.tools';

function through(body: unknown) {
  const req = { body, query: {} } as unknown as Request;
  sanitizeInput(req, {} as Response, () => {});
  let status = 0;
  let nextCalled = false;
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json() {
      return this;
    },
  } as unknown as Response;
  rejectWriteBatches(req, res, () => {
    nextCalled = true;
  });
  return { req, status, nextCalled };
}

const writeTool = [...ADMIN_WRITE_TOOL_NAMES][0];
const call = (name: string, id: number) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name, arguments: {} },
});

describe('MCP batch body survives the sanitizer', () => {
  it('a batch reaches the route as an array', () => {
    const { req } = through([call('x', 1), call('y', 2)]);
    expect(Array.isArray(req.body)).toBe(true);
    expect((req.body as unknown[]).length).toBe(2);
  });

  it('a batch containing a write call is refused with 400', () => {
    expect(writeTool).toBeTruthy();
    const { status, nextCalled } = through([call(writeTool, 1), call(writeTool, 2)]);
    expect(status).toBe(400);
    expect(nextCalled).toBe(false);
  });

  it('a single write message passes on to the limiter', () => {
    const { status, nextCalled } = through(call(writeTool, 1));
    expect(status).toBe(0);
    expect(nextCalled).toBe(true);
  });
});
