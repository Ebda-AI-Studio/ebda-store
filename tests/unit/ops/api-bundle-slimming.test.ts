import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error plain .mjs helpers, no types
import {
  MIME_OMITTED_TYPES,
  slimMimeDb,
  slimPrismaSchema,
} from '../../../scripts/ci/api-bundle-slimming.mjs';
// @ts-expect-error plain .mjs helper, no types
import { renderSlimMimeDb, SLIM_PATH } from '../../../scripts/ci/gen-mime-db-slim.mjs';
// @ts-expect-error plain .mjs helper, no types
import { slimGeneratedFile } from '../../../scripts/ci/slim-prisma-client.mjs';

// Ruling BUNDLE-BUDGET-5: three build-time slimmings that must not change behaviour.
const ROOT = join(__dirname, '../../..');
const require_ = createRequire(import.meta.url);

/** Schema tokens outside comments, with string literals kept whole: what the Prisma parser actually reads. */
function tokens(schema: string): string[] {
  const out: string[] = [];
  for (const m of schema.matchAll(/\/\/[^\n]*|"(?:[^"\\\n]|\\.)*"|[A-Za-z_][\w]*|\d+|[^\s\w]/g)) {
    if (!m[0].startsWith('//')) out.push(m[0]);
  }
  return out;
}

describe('slimPrismaSchema', () => {
  it('drops comments, blank lines and padding but keeps "//" inside strings', () => {
    const src = [
      '// header',
      '',
      'model User {',
      '  /// doc comment',
      '  id     String   @id   // trailing',
      '  site   String   @default("https://ebda.app/x")',
      '}',
    ].join('\n');
    expect(slimPrismaSchema(src)).toBe(
      'model User {\nid String @id\nsite String @default("https://ebda.app/x")\n}\n'
    );
  });

  it('is idempotent', () => {
    const once = slimPrismaSchema('a   b // c\n\n// d\n');
    expect(slimPrismaSchema(once)).toBe(once);
  });

  it('keeps the exact token stream of the real schema while cutting at least 40% of it', () => {
    const real = readFileSync(join(ROOT, 'packages/database/prisma/schema.prisma'), 'utf8');
    const slim = slimPrismaSchema(real);
    expect(tokens(slim)).toEqual(tokens(real));
    expect(slim.length).toBeLessThan(real.length * 0.6);
  });
});

describe('slimGeneratedFile', () => {
  it('rewrites only the inlineSchema string, keeps the file valid JS and is idempotent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'slim-prisma-'));
    const file = join(dir, 'wasm.js');
    const schema = '// c\nmodel A {\n  id   Int   @id // x\n}\n';
    writeFileSync(
      file,
      `const config = {\n  "inlineSchema": ${JSON.stringify(schema)},\n  "inlineSchemaHash": "abc"\n}\nmodule.exports = config\n`
    );
    expect(slimGeneratedFile(file)).toBeGreaterThan(0);
    const cfg = require_(file);
    expect(cfg.inlineSchema).toBe('model A {\nid Int @id\n}\n');
    expect(cfg.inlineSchemaHash).toBe('abc');
    expect(slimGeneratedFile(file)).toBe(0);
  });

  it('leaves a file without an inline schema alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'slim-prisma-'));
    const file = join(dir, 'x.js');
    writeFileSync(file, 'module.exports = 1\n');
    expect(slimGeneratedFile(file)).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe('module.exports = 1\n');
  });
});

/** mime-types' extension -> type table (same preference rules), built from any mime-db shaped object. */
function extensionTable(db: Record<string, { source?: string; extensions?: string[] }>) {
  const preference = ['nginx', 'apache', undefined, 'iana'];
  const types: Record<string, string> = {};
  for (const type of Object.keys(db)) {
    const exts = db[type].extensions;
    if (!exts?.length) continue;
    for (const ext of exts) {
      if (types[ext]) {
        const from = preference.indexOf(db[types[ext]].source);
        const to = preference.indexOf(db[type].source);
        if (
          types[ext] !== 'application/octet-stream' &&
          (from > to || (from === to && types[ext].slice(0, 12) === 'application/'))
        )
          continue;
      }
      types[ext] = type;
    }
  }
  return types;
}

describe('slimMimeDb', () => {
  const full = require_('mime-db') as Record<
    string,
    { source?: string; extensions?: string[]; charset?: string; compressible?: boolean }
  >;

  it('omits exactly the two brand-token types and nothing else', () => {
    expect(MIME_OMITTED_TYPES).toHaveLength(2);
    const slim = slimMimeDb(full);
    for (const type of MIME_OMITTED_TYPES) {
      expect(full[type]).toBeDefined();
      expect(slim[type]).toBeUndefined();
    }
  });

  it('resolves every other extension to the same type and every charset to the same value', () => {
    const slim = slimMimeDb(full);
    const kept: typeof full = {};
    for (const type of Object.keys(full))
      if (!MIME_OMITTED_TYPES.includes(type)) kept[type] = full[type];
    expect(extensionTable(slim)).toEqual(extensionTable(kept));
    for (const type of Object.keys(kept)) {
      expect(slim[type]?.charset).toBe(kept[type].charset);
    }
  });

  it('is much smaller than the full database', () => {
    expect(JSON.stringify(slimMimeDb(full)).length).toBeLessThan(JSON.stringify(full).length * 0.5);
  });

  it('keeps the committed apps/api/src/cf/stubs/mime-db.json in step with the installed mime-db', () => {
    expect(readFileSync(SLIM_PATH, 'utf8')).toBe(renderSlimMimeDb());
  });
});
