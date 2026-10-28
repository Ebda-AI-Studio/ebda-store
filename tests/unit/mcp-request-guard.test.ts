/**
 * MCP request guard (Ruling ITEST-11): oversized bodies and array/depth/node bombs are refused at our
 * boundary, before the SDK's zod parse. Ordinary JSON-RPC messages pass untouched.
 */
import { describe, it, expect } from 'vitest';
import type { Request, Response } from 'express';
import {
  mcpBodyViolation,
  mcpRequestGuard,
  MCP_MAX_ARRAY_LENGTH,
  MCP_MAX_BODY_BYTES,
  MCP_MAX_DEPTH,
} from '@api/mcp/request-guard';
import mcpRouter from '@api/routes/mcp.routes';
import mcpAdminRouter from '@api/routes/mcp-admin.routes';

function run(body: unknown, contentLength?: number) {
  const req = {
    body,
    headers: contentLength === undefined ? {} : { 'content-length': String(contentLength) },
  } as unknown as Request;
  let status = 0;
  let payload: any;
  let next = false;
  const res = {
    status(c: number) {
      status = c;
      return this;
    },
    json(b: unknown) {
      payload = b;
      return this;
    },
  } as unknown as Response;
  mcpRequestGuard(req, res, () => {
    next = true;
  });
  return { status, payload, next };
}

const message = {
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name: 'search_products', arguments: { query: 'abaya', limit: 10 } },
};

describe('mcpRequestGuard', () => {
  it('passes an ordinary tool call and an initialize message', () => {
    expect(run(message).next).toBe(true);
    expect(
      run({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'a' } },
      }).next
    ).toBe(true);
  });

  it('refuses a declared body over the byte cap with 413', () => {
    const r = run(message, MCP_MAX_BODY_BYTES + 1);
    expect(r.status).toBe(413);
    expect(r.payload.error.code).toBe(-32600);
    expect(r.next).toBe(false);
  });

  it('refuses an array longer than the cap anywhere in the message, and accepts the cap exactly', () => {
    const bomb = (n: number) => ({
      ...message,
      params: { name: 'x', arguments: { items: new Array(n).fill({ a: 1 }) } },
    });
    expect(run(bomb(MCP_MAX_ARRAY_LENGTH)).next).toBe(true);
    const r = run(bomb(MCP_MAX_ARRAY_LENGTH + 1));
    expect(r.status).toBe(400);
    expect(r.next).toBe(false);
  });

  it('refuses a deeply nested value without overflowing the stack', () => {
    let deep: any = {};
    const root = deep;
    for (let i = 0; i < 50_000; i++) {
      deep.n = {};
      deep = deep.n;
    }
    expect(mcpBodyViolation(root)).toBe('nested too deeply');
    expect(mcpBodyViolation({ a: [[[[[[[[[[[[[1]]]]]]]]]]]]] })).toBe(
      MCP_MAX_DEPTH < 13 ? 'nested too deeply' : null
    );
  });

  it('refuses a message with too many fields', () => {
    const wide: Record<string, number> = {};
    for (let i = 0; i < 6000; i++) wide['k' + i] = i;
    // scalars do not count as nodes; objects and arrays do
    const objs = { list: Array.from({ length: 100 }, () => ({})) };
    expect(mcpBodyViolation(wide)).toBeNull();
    expect(mcpBodyViolation(objs)).toBeNull();
    const many: any = {};
    for (let i = 0; i < 6000; i++) many['o' + i] = {};
    expect(mcpBodyViolation(many)).toBe('too many fields');
  });

  it('is mounted on both MCP routers', () => {
    for (const r of [mcpRouter, mcpAdminRouter]) {
      const names = (r as any).stack.map((l: any) => l.handle?.name);
      expect(names).toContain('mcpRequestGuard');
    }
  });
});
