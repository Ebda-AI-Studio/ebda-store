/**
 * Merchant MCP phase 4 (Ruling MCP-P4-LAUNCH-1): the public SKILL.md manifest must equal the REAL
 * tool registry. A tool added to `buildStoreMcpServer` without a manifest entry (so without a skill),
 * or a manifest entry whose tool is gone, fails here - so a published skill can never name a tool the
 * server does not expose, nor hide one it does.
 */
import { parse as parseYaml } from 'yaml';
import { describe, it, expect, vi } from 'vitest';

vi.mock('@ebda/database', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  prisma: new Proxy({}, { get: () => new Proxy({}, { get: () => vi.fn() }) }),
}));
vi.mock('@api/middleware/security', () => ({ auditLog: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@api/lib/logger', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { buildStoreMcpServer } from '@api/mcp/store-mcp-server';
import { MCP_READ_TOOLS, MCP_WRITE_TOOLS } from '@api/mcp/agent-auth';
import {
  renderStoreMcpSkills,
  skillNameForTool,
  STORE_MCP_TOOL_SKILLS,
  STORE_SHOPPING_SKILL_NAME,
} from '@ebda/shared';

const store = { id: 's1', name: 'Store A', slug: 'store-a', currency: 'EGP', domain: null };
const registered = () =>
  Object.keys(
    (buildStoreMcpServer(store) as unknown as { _registeredTools: Record<string, unknown> })
      ._registeredTools
  ).sort();
const ctx = { storeName: 'Store A', storeNameAr: 'متجر أ', mcpUrl: 'https://api.test/mcp/store-a' };

describe('store MCP skills == real tool registry', () => {
  it('every registered tool has a manifest entry and every entry has a registered tool', () => {
    expect(STORE_MCP_TOOL_SKILLS.map(t => t.name).sort()).toEqual(registered());
  });

  it('manifest read/write kind matches the auth classification', () => {
    for (const t of STORE_MCP_TOOL_SKILLS) {
      expect(t.kind === 'write' ? MCP_WRITE_TOOLS.has(t.name) : MCP_READ_TOOLS.has(t.name)).toBe(
        true
      );
    }
  });

  it('rendered skills = one per tool + the workflow skill, names unique', () => {
    const skills = renderStoreMcpSkills(ctx);
    const names = skills.map(s => s.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.filter(n => n !== STORE_SHOPPING_SKILL_NAME).sort()).toEqual(
      registered().map(skillNameForTool).sort()
    );
  });

  it('every skill is valid SKILL.md (frontmatter name matches) and the workflow names only real tools', () => {
    const real = new Set(registered());
    for (const s of renderStoreMcpSkills(ctx)) {
      expect(s.body.startsWith(`---\nname: ${s.name}\ndescription: `)).toBe(true);
    }
    const flow = renderStoreMcpSkills(ctx).find(s => s.name === STORE_SHOPPING_SKILL_NAME)!;
    const named = [...flow.body.matchAll(/`([a-z_]+)`/g)]
      .map(m => m[1])
      .filter(n => n.includes('_'));
    for (const n of named) if (n !== 'x_agent_key') expect(real.has(n)).toBe(true);
  });

  it('a store name with colons, quotes, a leading dash or a line break stays one YAML string in the front matter', () => {
    const hostile = [
      'Bob: the "best" shop',
      "O'Neil's: #1 - [gold] {rings}",
      '- evil\nname: injected\nrole: admin',
      '& *alias !tag | > key: v',
      'Back\\slash "q" \u2028 sep',
    ];
    for (const storeName of hostile) {
      for (const s of renderStoreMcpSkills({ ...ctx, storeName })) {
        const m = /^---\n([\s\S]*?)\n---\n/.exec(s.body);
        expect(m, `${s.name}: front matter is not closed`).not.toBeNull();
        const fm = parseYaml(m![1]) as Record<string, unknown>;
        expect(
          Object.keys(fm).sort(),
          `${storeName}: extra keys leaked into the front matter`
        ).toEqual(['description', 'name']);
        expect(fm.name).toBe(s.name);
        expect(typeof fm.description).toBe('string');
        // the store name survives (line breaks flattened to one space), it is only quoted
        expect(fm.description as string).toContain(
          storeName.replace(/\s*[\r\n\u2028\u2029]+\s*/g, ' ')
        );
      }
    }
  });

  it('skills leak no secret-shaped values', () => {
    const all = renderStoreMcpSkills(ctx)
      .map(s => s.body)
      .join('\n');
    expect(all).not.toMatch(/fwbm?_|ebdam_|sk_live|Bearer\s/i);
  });
});
