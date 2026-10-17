/**
 * Gate (Task 14, coordinator ruling): a planner / index test must run as the strict-RLS role
 * `ebda_app`, never as the owner.
 *
 * Under RLS the tenant policy is a security barrier; a user predicate whose functions are not
 * LEAKPROOF (`ILIKE`, `btrim`, `regexp_replace`, ...) cannot be an index condition. As the owner
 * (BYPASSRLS) every index "works", so an owner-only planner test passes while production scans
 * every row of the store. This happened for nine trigram indexes (SEARCH-T14-1, SEARCH-T14-5):
 * their planner tests were green for months.
 *
 * A test file that EXPLAINs, toggles a planner setting (`enable_*`), or reads index scan counters
 * must import `tests/helpers/app-role-planner` (it runs the production statements as `ebda_app`
 * and reads the index's own scan counter). The one allowed exception is a pure SQL-SHAPE check
 * (for example "the immutable helper is inlined") that says so and why with
 * `planner-owner-ok: <reason>`; the marker is refused in a file that toggles `enable_*`, because forcing the planner is an
 * index-use claim.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const HELPER = 'app-role-planner';

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(test|spec)\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Strip comments so prose that mentions EXPLAIN does not count as a planner test. */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

export interface PlannerFinding {
  file: string;
  problem: string;
}

/** `EXPLAIN` of a statement, in any case, with or without options or an interpolated statement. */
const EXPLAIN =
  /\bexplain\s*(?:\([^)]*\)\s*)?(?:(?:analyze|verbose)\s+)*(?:select|with|insert|update|delete|merge|execute|values|table)\b|\bexplain\s*(?:\([^)]*\)\s*)?\$\{/i;
/** Any planner setting. */
const ENABLE = /\benable_\w+/i;
/** Scan-counter reads: `idx_scan` and friends, the `pg_stat[io]_*_indexes/tables` views (not `pg_stat_activity`). */
const COUNTERS =
  /\bidx_(?:scan|tup_read|tup_fetch|blks_\w+)\b|\bseq_scan\b|\bpg_stat(?:io)?_(?:all_|user_|sys_)?(?:indexes|tables)\b|\bpg_stat_(?:clear_snapshot|force_next_flush|reset\w*)\b/i;

/** Exported for the self-test below. */
export function plannerFindings(file: string, src: string): PlannerFinding[] {
  if (file.endsWith('planner-tests-run-as-app-role.test.ts')) return [];
  const body = code(src);
  const planner = EXPLAIN.test(body) || ENABLE.test(body) || COUNTERS.test(body);
  if (!planner) return [];
  // REAL use of the helper: an import of createAppPlanner from the module AND a call of it, in
  // comment-stripped code. A mention in a comment or a string, or an import of `appDatabaseUrl`
  // alone, is not use.
  const imported = new RegExp(
    `\\bimport\\s*(?:type\\s+)?\\{[^}]*\\bcreateAppPlanner\\b[^}]*\\}\\s*from\\s*['"][^'"]*${HELPER}['"]`
  ).test(body);
  const called = /\bcreateAppPlanner\s*\(/.test(body);
  if (imported && called) return [];
  const marker = /planner-owner-ok:\s*(.{20,})/.exec(src);
  if (!marker)
    return [
      {
        file,
        problem: `plans a query without calling createAppPlanner from ${HELPER} (no planner-owner-ok marker)`,
      },
    ];
  // The opt-out is for a pure SQL-SHAPE check. Forcing the planner or reading index counters is an
  // index-use claim, which only means something as ebda_app.
  if (ENABLE.test(body) || COUNTERS.test(body))
    return [
      {
        file,
        problem:
          'planner-owner-ok is not allowed in a file that toggles enable_* or reads scan counters (idx_scan, pg_stat*_indexes/tables): those are index-use claims, which only mean something as ebda_app',
      },
    ];
  return [];
}

describe('planner/index tests run as ebda_app (Task 14 gate)', () => {
  it('no test plans a query as the owner without saying why', () => {
    const findings = walk(path.join(ROOT, 'tests'))
      .concat(walk(path.join(ROOT, 'apps')), walk(path.join(ROOT, 'packages')))
      .flatMap(f => plannerFindings(path.relative(ROOT, f), fs.readFileSync(f, 'utf8')));
    expect(findings).toEqual([]);
  });

  it('the rule catches an owner-only planner test (planted case)', () => {
    const planted =
      "await tx.$executeRaw`SET LOCAL enable_seqscan = off`; await tx.$queryRawUnsafe('EXPLAIN SELECT 1')";
    expect(plannerFindings('x.test.ts', planted)).toHaveLength(1);
    expect(
      plannerFindings(
        'x.test.ts',
        `import { createAppPlanner } from '../helpers/${HELPER}'; const p = createAppPlanner(); ${planted}`
      )
    ).toEqual([]);
    const shapeOnly =
      "// planner-owner-ok: asserts the SQL shape (function is inlined), not index use\nawait tx.$queryRawUnsafe('EXPLAIN SELECT 1')";
    expect(plannerFindings('x.test.ts', shapeOnly)).toEqual([]);
    expect(
      plannerFindings('x.test.ts', `${shapeOnly}; SET LOCAL enable_seqscan = off`)
    ).toHaveLength(1);
    expect(plannerFindings('x.test.ts', '// mentions EXPLAIN in prose only\nconst a = 1;')).toEqual(
      []
    );
  });

  // Review I-3: every way round the first version of this gate, planted. Each must be refused.
  describe('planted bypasses (review I-3)', () => {
    const shape =
      '// planner-owner-ok: asserts the SQL shape, not index use (a long enough reason)\n';
    const bypasses: Record<string, string> = {
      'helper named only in a comment':
        "// uses app-role-planner\nawait prisma.$queryRawUnsafe('EXPLAIN SELECT 1')",
      'helper named only in a string':
        "const h = 'app-role-planner'; await prisma.$queryRawUnsafe('EXPLAIN SELECT 1')",
      'helper imported for its URL only, never called':
        "import { appDatabaseUrl } from '../helpers/app-role-planner';\nawait prisma.$queryRawUnsafe('EXPLAIN SELECT 1')",
      'lowercase explain': "await prisma.$queryRawUnsafe('explain select 1')",
      'explain with options in lowercase':
        "await prisma.$queryRawUnsafe('explain (format json) select 1')",
      'explain of an interpolated statement': 'await tx.$queryRaw`EXPLAIN (COSTS OFF) ${sql}`',
      'an enable_ setting that was not on the old list': 'SET LOCAL enable_indexonlyscan = off',
      enable_material: 'SET LOCAL enable_material = off',
      'idx_scan read as the owner':
        'await prisma.$queryRaw`SELECT idx_scan FROM pg_stat_user_indexes`',
      'pg_stat_all_indexes read as the owner':
        'await prisma.$queryRaw`SELECT 1 FROM pg_stat_all_indexes`',
      'pg_statio index counters': 'await prisma.$queryRaw`SELECT 1 FROM pg_statio_user_indexes`',
      'marker plus idx_scan': `${shape}await prisma.$queryRaw\`SELECT idx_scan FROM pg_stat_user_indexes\``,
      'marker plus pg_stat_user_indexes': `${shape}await prisma.$queryRaw\`SELECT 1 FROM pg_stat_user_indexes\``,
      'marker plus any enable_': `${shape}SET LOCAL enable_hashagg = off; EXPLAIN SELECT 1`,
    };
    for (const [name, src] of Object.entries(bypasses))
      it(`refuses: ${name}`, () => {
        expect(plannerFindings('x.test.ts', src).length).toBeGreaterThan(0);
      });

    it('accepts a real use: an import and a call of the helper', () => {
      const ok =
        "import { createAppPlanner } from '../helpers/app-role-planner';\nconst p = createAppPlanner();\nawait p.inStore(s, () => prisma.$queryRaw`EXPLAIN SELECT 1`);\nSELECT idx_scan FROM pg_stat_user_indexes;";
      expect(plannerFindings('x.test.ts', ok)).toEqual([]);
    });
    it('does not trip on the English word in prose, a test title, or pg_stat_activity', () => {
      expect(plannerFindings('x.test.ts', 'SELECT count(*) FROM pg_stat_activity')).toEqual([]);
      expect(
        plannerFindings('x.test.ts', "it('explain the result to the shopper', () => {});")
      ).toEqual([]);
    });
  });
});
