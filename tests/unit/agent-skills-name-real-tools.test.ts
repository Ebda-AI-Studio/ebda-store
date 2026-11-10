/**
 * Every tool a shipped skill names must actually be registered.
 *
 * A `SKILL.md` is a promise to a merchant: "install this and it will do X".
 * If it calls `admin_refund_order` and the server exposes no such tool, the
 * skill fails on first use and reads as a broken product rather than a missing
 * feature. That is the "heading is a contract" class — copy makes a promise no
 * test asserts — and it is cheap to close here because both sides are in this
 * repo.
 *
 * The gate runs in both directions on purpose. Forward: no skill names a tool
 * that does not exist. Backward: the tool inventory this test reads is derived
 * from the registrar sources, not hand-listed, so renaming a tool reddens this
 * rather than silently making every skill wrong.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';

const ROOT = join(__dirname, '../..');
const SKILLS_DIR = join(ROOT, 'skills');
const TOOL_SOURCES = [
  'apps/api/src/mcp/tools/admin-read.tools.ts',
  'apps/api/src/mcp/tools/catalog.tools.ts',
  'apps/api/src/mcp/tools/cart.tools.ts',
  'apps/api/src/mcp/tools/order.tools.ts',
];

/** Tool names as REGISTERED, read from the registrar call sites. */
function registeredTools(): Set<string> {
  const names = new Set<string>();
  for (const rel of TOOL_SOURCES) {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    for (const m of src.matchAll(/registerTool\(\s*'([a-z0-9_]+)'/g)) names.add(m[1]);
  }
  return names;
}

function skillDirs(): string[] {
  if (!existsSync(SKILLS_DIR)) return [];
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);
}

describe('agent skills name only tools that exist', () => {
  const tools = registeredTools();
  const dirs = skillDirs();

  it('found the tool registry (guards against an empty-set pass)', () => {
    // If the regex ever stops matching, every skill would trivially "pass"
    // because nothing is flagged. Assert the inventory is real first.
    expect(tools.size).toBeGreaterThanOrEqual(13);
    expect(tools).toContain('admin_get_analytics');
    expect(tools).toContain('place_order');
  });

  it('found the skills (guards against an empty-set pass)', () => {
    expect(dirs.length).toBeGreaterThanOrEqual(3);
  });

  it.each(skillDirs())('%s/SKILL.md', dir => {
    const path = join(SKILLS_DIR, dir, 'SKILL.md');
    expect(existsSync(path), `${dir} has no SKILL.md`).toBe(true);
    const src = readFileSync(path, 'utf8');

    // Any identifier shaped like one of our tool names. Deliberately matches
    // prose as well as code blocks — a skill's instructions ARE its code, and
    // "call admin_refund_order" in a sentence fails exactly as hard.
    const mentioned = new Set(
      [...src.matchAll(/\b((?:admin_|get_|search_|add_to_|view_|place_)[a-z0-9_]+)\b/g)].map(
        m => m[1]
      )
    );

    const unknown = [...mentioned].filter(n => !tools.has(n));
    expect(
      unknown,
      `${dir}/SKILL.md names tool(s) the server does not expose: ${unknown.join(', ')}. ` +
        `Either the tool was renamed, or the skill promises a capability that ` +
        `does not exist yet — ship the skill with the tool, not before it.`
    ).toEqual([]);
  });

  it.each(skillDirs())('%s has frontmatter with a name and a description', dir => {
    const src = readFileSync(join(SKILLS_DIR, dir, 'SKILL.md'), 'utf8');
    expect(src.startsWith('---\n'), `${dir}: no frontmatter block`).toBe(true);
    // A real YAML parse of the frontmatter block: a missing closing `---` is a failure, never a window
    // that swallows the body (where `name:` could appear in prose and pass).
    const block = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(src);
    expect(block, `${dir}: frontmatter block is not closed with ---`).not.toBeNull();
    const fm = parseYaml(block![1]) as { name?: unknown; description?: unknown };
    expect(typeof fm.name, `${dir}: frontmatter has no name`).toBe('string');
    expect(String(fm.name).length).toBeGreaterThan(0);
    expect(typeof fm.description, `${dir}: frontmatter has no description`).toBe('string');
    expect(String(fm.description).length).toBeGreaterThan(0);
    // The directory name and the declared name must agree, or a client that
    // keys on one and displays the other shows the wrong skill.
    expect(fm.name).toBe(dir);
  });

  it('no skill claims a write while every admin tool is read-only', () => {
    // Phase 1 exposes reads only. A skill that says it will change something
    // is the same broken promise as naming a missing tool.
    const writeTools = ['admin_create_product', 'admin_update_product', 'admin_delete_product'];
    const anyWriteToolExists = writeTools.some(t => tools.has(t));
    if (anyWriteToolExists) return; // phase 2 landed; this guard retires itself

    for (const dir of skillDirs()) {
      const src = readFileSync(join(SKILLS_DIR, dir, 'SKILL.md'), 'utf8');
      expect(
        /every tool here is read-only|none of them writes|read-only/i.test(src),
        `${dir}/SKILL.md should state that its tools are read-only while phase 1 is all that exists`
      ).toBe(true);
    }
  });
});
