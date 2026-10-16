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

/** Exported for the self-test below. */
export function plannerFindings(file: string, src: string): PlannerFinding[] {
  if (file.endsWith('planner-tests-run-as-app-role.test.ts')) return [];
  const body = code(src);
  const planner =
    /\bEXPLAIN\b/.test(body) ||
    /\benable_(seqscan|indexscan|bitmapscan|nestloop|hashjoin|mergejoin|sort)\b/.test(body) ||
    /\bidx_scan\b/.test(body);
  if (!planner) return [];
  if (src.includes(HELPER)) return [];
  const marker = /planner-owner-ok:\s*(.{20,})/.exec(src);
  if (!marker)
    return [
      { file, problem: `plans a query without importing ${HELPER} (no planner-owner-ok marker)` },
    ];
  const claimsIndex = /\benable_\w+\b/.test(body);
  if (claimsIndex)
    return [
      {
        file,
        problem:
          'planner-owner-ok is not allowed in a file that toggles enable_*: forcing the planner is an index-use claim, which only means something as ebda_app',
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
        `import { createAppPlanner } from '../helpers/${HELPER}'; ${planted}`
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
});
