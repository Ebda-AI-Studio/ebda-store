/**
 * Code facts for the capability guards (foundation `CodeFacts`), derived from the REAL code, never from the registry:
 * globbed admin pages, the Express route table (walked like public-mount-admin-route-guard.test.ts) and the merchant MCP tools.
 * Callers get a fresh module graph per call (vi.resetModules + vi.doMock of the auth middleware), so use it from beforeAll.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { vi } from 'vitest';
import type { GuardConfig } from '../../packages/shared/src/foundation/capability';
import type { CodeFacts } from '../../packages/shared/src/foundation/capability-coverage';

export const REPO_ROOT = resolve(__dirname, '../..');
const ROLE_TAG = Symbol.for('test.capabilityRoles');
const VERBS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

interface Layer {
  route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> };
  handle: { stack?: Layer[] } & ((...args: unknown[]) => unknown);
  regexp: RegExp & { fast_slash?: boolean };
  keys: Array<{ name: string }>;
}
interface Scoped {
  prefix: string;
  roles: string[][];
}

/** Recover an Express 4 mount prefix from its regexp. */
function mountPrefix(layer: Layer): string {
  if (layer.regexp.fast_slash) return '';
  let src = layer.regexp.source.replace(/^\^/, '').replace(/\\\/\?\(\?=\\\/\|\$\)$/, '');
  let i = 0;
  // path-to-regexp renders ":storeId" as (?:\/([^\/]+?)) after a "/" and as (?:([^\/]+?)) elsewhere
  src = src.replace(
    /\(\?:\\\/\(\[\^\\?\/\]\+\?\)\)/g,
    () => `/:${layer.keys[i++]?.name ?? 'param'}`
  );
  src = src.replace(/\(\?:\(\[\^\\?\/\]\+\?\)\)/g, () => `:${layer.keys[i++]?.name ?? 'param'}`);
  return src.replace(/\\\//g, '/');
}

const rolesOf = (handle: unknown): string[][] => {
  const t = (handle as Record<symbol, string[]> | undefined)?.[ROLE_TAG];
  return t ? [t] : [];
};
const covers = (mount: string, full: string) =>
  mount === '' || full === mount || full.startsWith(`${mount}/`);

export interface WalkedRoute {
  method: string;
  path: string;
  /** every authorize(...) role list in the chain (router-level ones included) */
  roleLists: string[][];
}

/** Walk an Express 4 router stack; `router.use(authorize(..))` guards every LATER layer under its mount. */
export function walkRoutes(stack: Layer[], prefix = '', inherited: Scoped[] = []): WalkedRoute[] {
  const out: WalkedRoute[] = [];
  const scoped = [...inherited];
  for (const layer of stack) {
    if (layer.route) {
      const full = prefix + layer.route.path;
      const roleLists = [
        ...scoped.filter(s => covers(s.prefix, full)).flatMap(s => s.roles),
        ...layer.route.stack.flatMap(h => rolesOf(h.handle)),
      ];
      for (const m of Object.keys(layer.route.methods))
        out.push({ method: m.toUpperCase(), path: full, roleLists });
    } else if (Array.isArray(layer.handle?.stack)) {
      out.push(...walkRoutes(layer.handle.stack, prefix + mountPrefix(layer), scoped));
    } else {
      const roles = rolesOf(layer.handle);
      if (roles.length) scoped.push({ prefix: prefix + mountPrefix(layer), roles });
    }
  }
  return out;
}

/** Routes in code -> CodeFacts routes: ALL expands to the verbs in use, HEAD/OPTIONS dropped, kind from cfg then super_admin tags. */
export function toFactRoutes(walked: WalkedRoute[], cfg: GuardConfig): CodeFacts['routes'] {
  const out: CodeFacts['routes'] = [];
  for (const r of walked) {
    if (r.method === 'HEAD' || r.method === 'OPTIONS') continue;
    const methods = r.method === 'ALL' ? VERBS : [r.method];
    const cfgKind = cfg.routeKinds.find(k => new RegExp(k.match).test(r.path))?.kind;
    const superOnly =
      r.roleLists.length > 0 && r.roleLists.every(l => l.length === 1 && l[0] === 'super_admin');
    const kind = cfgKind ?? (superOnly ? 'super_admin' : 'merchant');
    for (const method of methods) out.push({ method, path: r.path, kind });
  }
  return out;
}

/** apps/admin/src/app/**\/page.tsx -> route paths: (group) and @slot segments dropped, [id] kept. */
export function adminPages(root = REPO_ROOT): string[] {
  const base = join(root, 'apps/admin/src/app');
  const pages: string[] = [];
  const walk = (dir: string, segs: string[]) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        const hidden = /^\(.*\)$/.test(e.name) || e.name.startsWith('@') || e.name.startsWith('_');
        walk(join(dir, e.name), hidden ? segs : [...segs, e.name]);
      } else if (e.name === 'page.tsx') pages.push(`/${segs.join('/')}`);
    }
  };
  if (existsSync(base)) walk(base, []);
  return [...new Set(pages)].sort();
}

/** The names the merchant MCP server registers (real registration, stub store). */
async function merchantMcpTools(): Promise<string[]> {
  const { buildMerchantMcpServer } = await import('@api/mcp/merchant-mcp-server');
  const server = buildMerchantMcpServer({ slug: 'capability-facts' } as never) as unknown as {
    _registeredTools: Record<string, unknown>;
  };
  return Object.keys(server._registeredTools).sort();
}

export async function storeCodeFacts(cfg: GuardConfig): Promise<CodeFacts> {
  vi.resetModules();
  vi.doMock('@api/middleware/auth', async importOriginal => {
    const actual = await importOriginal<typeof import('@api/middleware/auth')>();
    return {
      ...actual,
      authorize: (...roles: string[]) => {
        const mw = actual.authorize(...roles);
        (mw as unknown as Record<symbol, string[]>)[ROLE_TAG] = roles;
        return mw;
      },
    };
  });
  const { default: apiRoutes } = await import('@api/routes');
  const { FEATURE_KEYS_ARRAY } = await import('../../packages/shared/src/features');
  const walked = walkRoutes((apiRoutes as unknown as { stack: Layer[] }).stack);
  return {
    pages: adminPages(),
    routes: toFactRoutes(walked, cfg),
    mcpTools: await merchantMcpTools(),
    planGates: [...FEATURE_KEYS_ARRAY],
  };
}

export const readConfig = (): GuardConfig =>
  JSON.parse(readFileSync(join(REPO_ROOT, 'capabilities/guard.config.json'), 'utf8'));
