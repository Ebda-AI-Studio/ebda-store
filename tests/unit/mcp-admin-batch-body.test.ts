/**
 * B0 Task 9 fix rounds 1-2: JSON-RPC batches on the MCP routes.
 *
 * Before Task 9 the global sanitizer turned an array body into `{"0":...}`; the SDK transport
 * then rejected it with HTTP 400 -32700 Parse error (no `jsonrpc` key) — 0 writes, 0 write-limiter
 * tokens, and every batch, read or write, refused on both `/mcp/admin/:slug` and `/mcp/:slug`.
 * Batches have never worked in production. The sanitizer now keeps array bodies, so a batch of
 * up to 100 messages would reach the transport for ONE limiter token. `rejectBatches` keeps the
 * production behaviour explicitly: any array body is a 400 -32600, mounted first on both routers.
 */
import { describe, it, expect } from 'vitest';
import type { Request, Response } from 'express';
import { sanitizeInput } from '@api/middleware/security';
import { rejectBatches } from '@api/mcp/reject-batches';
import mcpAdminRouter, { merchantMcpIpLimiter } from '@api/routes/mcp-admin.routes';
import mcpRouter from '@api/routes/mcp.routes';

function through(body: unknown) {
  const req = { body, query: {} } as unknown as Request;
  sanitizeInput(req, {} as Response, () => {});
  let status = 0;
  let payload: any;
  let nextCalled = false;
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json(b: unknown) {
      payload = b;
      return this;
    },
  } as unknown as Response;
  rejectBatches(req, res, () => {
    nextCalled = true;
  });
  return { req, status, payload, nextCalled };
}

const call = (name: string, id: number) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name, arguments: {} },
});

describe('MCP batches are refused', () => {
  it('a batch survives the sanitizer as an array and is refused with 400 -32600; next never runs', () => {
    const { req, status, payload, nextCalled } = through([call('view_cart', 1), call('x', 2)]);
    expect(Array.isArray(req.body)).toBe(true);
    expect(status).toBe(400);
    expect(nextCalled).toBe(false);
    expect(payload).toEqual({
      jsonrpc: '2.0',
      error: {
        code: -32600,
        message: 'Batch requests are not supported; send one message per request.',
      },
      id: null,
    });
  });

  it('a read-only batch is refused too', () => {
    expect(through([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]).status).toBe(400);
  });

  it('a single message passes', () => {
    const { status, nextCalled } = through(call('view_cart', 1));
    expect(status).toBe(0);
    expect(nextCalled).toBe(true);
  });
});

describe('rejectBatches is mounted first on both MCP routers, before their limiters', () => {
  const handles = (r: unknown) =>
    (r as { stack: Array<{ handle: unknown; route?: unknown }> }).stack.map(l => l.handle);

  it('merchant admin: before merchantMcpIpLimiter', () => {
    const h = handles(mcpAdminRouter);
    expect(h[0]).toBe(rejectBatches);
    expect(h.indexOf(rejectBatches)).toBeLessThan(h.indexOf(merchantMcpIpLimiter));
  });

  it('buyer: the first layer, ahead of publicLimiter', () => {
    expect(handles(mcpRouter)[0]).toBe(rejectBatches);
  });
});
