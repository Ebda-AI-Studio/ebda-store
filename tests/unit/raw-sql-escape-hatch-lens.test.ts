import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * LENS: "the ORM protected you; the escape hatch does not."
 *
 * The AI needs a join or a search the ORM's query builder cannot express, so it
 * drops to raw SQL — and every protection Prisma provided disappears at that
 * line. A crafted string in a search field, a filter, or a SORT PARAMETER then
 * reaches the database as command rather than as data.
 *
 * Prisma has two shapes and they are not equally safe:
 *
 *   prisma.$queryRaw`... ${value} ...`       tagged template -> PARAMETERISED
 *   prisma.$queryRawUnsafe(`... ${value}`)   a built string  -> NOT
 *   Prisma.raw(value)                        raw SQL inside a SAFE template
 *
 * The third is the one that hides: it sits inside a tagged template that looks
 * parameterised, and injects its argument verbatim.
 *
 * Run against this codebase the answer was clean — every `…Unsafe` call
 * interpolates an internally-generated name (a savepoint counter, a constant)
 * or a value validated first, and the single `Prisma.raw` maps user input
 * through a ternary allowlist to fixed column literals. This gate exists so the
 * twentieth one, written next month, cannot be the exception.
 */

const ROOTS = ['apps', 'packages'];

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === '.next') continue;
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && p.endsWith('.ts') && !p.includes('.test.')) out.push(p);
    }
  };
  for (const r of ROOTS) walk(path.resolve(process.cwd(), r));
  return out;
}

const rel = (f: string) => path.relative(process.cwd(), f);

/**
 * Index of the character matching `src[openIdx]` (one of `<`/`(`), tracking
 * nesting depth. Used instead of a character-class regex because a generic
 * type argument can itself contain `<...>` — `Array<{ id: string }>` closes
 * the OUTER generic on its own final `>`, which `[^>]*` cannot cross.
 */
function findMatchingBracket(src: string, openIdx: number, open: string, close: string): number {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Index of the `)` closing the call whose `(` is at `openIdx`, skipping over
 * string/template literal contents so a stray paren inside a quoted value
 * cannot desync the count.
 */
function findCallArgsEnd(src: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === '`' || c === "'" || c === '"') {
      const quote = c;
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') i++;
        i++;
      }
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** The full backtick literal starting at `src[startIdx]` (which must be `` ` ``). */
function readTemplateLiteral(src: string, startIdx: number): string | null {
  if (src[startIdx] !== '`') return null;
  let i = startIdx + 1;
  while (i < src.length && src[i] !== '`') {
    if (src[i] === '\\') i++;
    i++;
  }
  return i < src.length ? src.slice(startIdx, i + 1) : null;
}

/**
 * If a `$queryRawUnsafe`/`$executeRawUnsafe` call's first argument is a bare
 * identifier rather than an inline template literal, trace it back to its
 * declaration (`const <name> = \`...\``) earlier in the same source, so a SQL
 * fragment built into a variable and then passed by name is not invisible to
 * this lens.
 */
function resolveIdentifierTemplate(src: string, name: string, beforeIndex: number): string | null {
  const declRe = new RegExp(`\\bconst\\s+${name}\\s*=\\s*\``, 'g');
  let best: string | null = null;
  for (const m of src.slice(0, beforeIndex).matchAll(declRe)) {
    const tplStart = m.index! + m[0].length - 1; // index of the opening backtick
    const tpl = readTemplateLiteral(src, tplStart);
    if (tpl) best = tpl; // keep the LAST (nearest-preceding) declaration
  }
  return best;
}

/** `$queryRawUnsafe` / `$executeRawUnsafe` whose SQL string interpolates. */
function unsafeInterpolating(): { file: string; args: string[] }[] {
  const out: { file: string; args: string[] }[] = [];
  for (const f of sourceFiles()) {
    const src = fs.readFileSync(f, 'utf-8');
    for (const m of src.matchAll(/\$(?:query|execute)RawUnsafe\b/g)) {
      let i = m.index! + m[0].length;
      while (/\s/.test(src[i])) i++;
      if (src[i] === '<') {
        const close = findMatchingBracket(src, i, '<', '>');
        if (close === -1) continue;
        i = close + 1;
        while (/\s/.test(src[i])) i++;
      }
      if (src[i] !== '(') continue; // not a call (e.g. a comment or property read)
      const argsEnd = findCallArgsEnd(src, i);
      if (argsEnd === -1) continue;

      let j = i + 1;
      while (/\s/.test(src[j])) j++;

      let sql: string | null = null;
      if (src[j] === '`') {
        sql = readTemplateLiteral(src, j);
      } else {
        const ident = /^[A-Za-z_$][\w$]*/.exec(src.slice(j))?.[0];
        if (ident) sql = resolveIdentifierTemplate(src, ident, m.index!);
      }
      if (!sql) continue;

      const args = [...sql.matchAll(/\$\{([^}]+)\}/g)].map(x => x[1].trim());
      if (args.length) out.push({ file: rel(f), args });
    }
  }
  return out;
}

/**
 * Files permitted to interpolate into an UNSAFE raw statement, each with the
 * reason the interpolated value cannot be caller text. Postgres cannot bind a
 * parameter in `SAVEPOINT` or `SET LOCAL`, so these genuinely cannot use the
 * parameterised form.
 */
const UNSAFE_INTERPOLATION_ALLOWED: Record<string, string> = {
  'apps/api/src/lib/savepoint.ts': 'name is `ebda_sp_${counter}`, generated here',
  'apps/api/src/services/accounting/journal.service.ts': 'sp is `je_idem_${Date.now()}`',
  'apps/api/src/lib/inngest/functions/audit-log-archive.ts': 'a module constant',
  'packages/database/src/index.ts': 'SET LOCAL cannot bind; UUID-validated then quote-escaped',
  'apps/api/src/services/accounting/reports.service.ts':
    "baseSql's ${asOf ? ... : ''} ternary chooses between two fixed SQL fragments " +
    '(neither derived from caller text); the actual date value is bound as $2, never interpolated',
  'apps/api/src/services/accounting/bank-reconcile.service.ts':
    'the only interpolation is COUNTED_STATUSES_SQL, a module constant imported from ' +
    'reports.service.ts; periodStart and statementId are always bound as $4/$5, never interpolated',
  'apps/api/src/lib/r2-references.ts':
    'table/column identifiers come from the R2_REFERENCE_COLUMNS module constant (checked against ' +
    'schema.prisma by tests/unit/r2-reference-registry.test.ts) and are double-quote-escaped; the ' +
    'URL, R2 key, cursor and page size are bound as $1/$2, never interpolated',
};

/** Files permitted to call `Prisma.raw`, with why the argument is not user text. */
const PRISMA_RAW_ALLOWED: Record<string, string> = {
  'apps/api/src/lib/inngest/functions/store-usage-snapshot.ts':
    'module-constant SQL fragments from lib/revenue-sql.ts (REVENUE-DEF-1): fixed literals, no caller input; every value stays a bound parameter',
  'apps/api/src/services/abandoned-cart.service.ts':
    'module-constant SQL fragments from lib/revenue-sql.ts (REVENUE-DEF-1): fixed literals, no caller input; every value stays a bound parameter',
  'apps/api/src/services/analytics.service.ts':
    'module-constant SQL fragments from lib/revenue-sql.ts (REVENUE-DEF-1): fixed literals, no caller input; every value stays a bound parameter',
  'apps/api/src/services/revenue.service.ts':
    'module-constant SQL fragments from lib/revenue-sql.ts (REVENUE-DEF-1): fixed literals, no caller input; every value stays a bound parameter',
  'apps/api/src/services/inventory.service.ts':
    'sortBy/sortOrder mapped through a ternary allowlist to fixed literals',
};

describe('raw SQL escape hatch', () => {
  it('finds raw calls at all — a scanner matching nothing proves nothing', () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(100);
    const anyRaw = files.some(f => /\$(?:query|execute)Raw/.test(fs.readFileSync(f, 'utf-8')));
    expect(anyRaw).toBe(true);
  });

  it('interpolates into an unsafe raw statement only where allowlisted', () => {
    for (const hit of unsafeInterpolating()) {
      expect(
        Object.keys(UNSAFE_INTERPOLATION_ALLOWED),
        `${hit.file} builds SQL by interpolation (${hit.args.join(', ')}). If the value ` +
          `cannot be caller text, add it to UNSAFE_INTERPOLATION_ALLOWED with the reason.`
      ).toContain(hit.file);
    }
  });

  it('calls Prisma.raw only where allowlisted', () => {
    // Prisma.raw injects verbatim INSIDE a tagged template that otherwise
    // parameterises — the most deceptive of the three shapes.
    for (const f of sourceFiles()) {
      const src = fs.readFileSync(f, 'utf-8');
      if (!src.includes('Prisma.raw(')) continue;
      expect(
        Object.keys(PRISMA_RAW_ALLOWED),
        `${rel(f)} calls Prisma.raw — its argument reaches SQL verbatim.`
      ).toContain(rel(f));
    }
  });

  it('keeps the sort allowlist a closed set of literals', () => {
    // The reel's exact example: a SORT PARAMETER reaching the database as
    // command. Guarded by mapping to literals, so assert the mapping survives.
    const src = fs.readFileSync(
      path.resolve(process.cwd(), 'apps/api/src/services/inventory.service.ts'),
      'utf-8'
    );
    const sortCol = /const sortColumn =([\s\S]*?);/.exec(src)?.[1] ?? '';
    // Every value it can produce is a quoted literal, never `options.` text.
    expect(sortCol).not.toMatch(/Prisma\.raw|options\?\.sortBy\s*\|\||`\$\{/);
    expect(sortCol).toMatch(/'p\.name'/);
    const sortDir = /const sortDir =([\s\S]*?);/.exec(src)?.[1] ?? '';
    expect(sortDir).toMatch(/'DESC'/);
    expect(sortDir).toMatch(/'ASC'/);
  });

  it('bounds the page size rather than trusting the caller', () => {
    // "A search field that accepts 10,000 characters is not a feature."
    const src = fs.readFileSync(
      path.resolve(process.cwd(), 'apps/api/src/services/inventory.service.ts'),
      'utf-8'
    );
    expect(src).toMatch(/Math\.min\(\s*\d+\s*,\s*Math\.max\(/);
  });
});
