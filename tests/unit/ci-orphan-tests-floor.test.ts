/**
 * #1438: the orphan-tests job in ci.yml only guarded the SECOND vitest
 * collection (`covered.size * 2 < all.size`) against coming back broken —
 * there was no floor on the FIRST one (`all`) at all. If that collector
 * itself returns empty or near-empty, `covered` (a filtered subset of `all`)
 * is empty too, `covered.size * 2 < all.size` is `0 < 0` (false), and the job
 * falls through to computing zero orphans and printing "No orphan test
 * files" — a green pass having discovered almost nothing, indistinguishable
 * from a genuinely clean, ~395-file repo.
 *
 * STRUCTURAL, not textual: the workflow is parsed as YAML, the job's `node -e`
 * script is parsed as JavaScript, and the checks are about its top-level
 * statements. Running the script is not practical here (it reads two vitest
 * JSON files the CI job produces and exits the process), and a text window
 * would be satisfied by the same words in a comment.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { parse as parseYaml } from 'yaml';
import { parseSource, callsTo } from './helpers/ts-ast';

const workflow = parseYaml(readFileSync(join(__dirname, '../../.github/workflows/ci.yml'), 'utf8'));

/** The JavaScript inside the orphan job's `node -e "…"` step, un-escaped from its shell quoting. */
function orphanScript(): ts.SourceFile {
  const steps: Array<{ run?: string }> = workflow.jobs?.['orphan-tests']?.steps ?? [];
  const run = steps
    .map(s => s.run ?? '')
    .find(r => r.includes('/all-tests.json') && r.includes('node -e "'));
  expect(
    run,
    'orphan-tests job or its node -e step is gone — this guard is measuring nothing'
  ).toBeDefined();
  const body = run!.slice(run!.indexOf('node -e "') + 'node -e "'.length, run!.lastIndexOf('"'));
  return parseSource('orphan.js', body.replace(/\\(["`$\\])/g, '$1'));
}

describe('#1438: orphan-tests job floors the FIRST collection too', () => {
  const sf = orphanScript();
  const top = sf.statements;
  const ifWhere = (cond: string) =>
    top.findIndex(s => ts.isIfStatement(s) && s.expression.getText().replace(/\s+/g, ' ') === cond);
  const allAt = top.findIndex(
    s =>
      ts.isVariableStatement(s) &&
      s.declarationList.declarations.some(
        d => d.name.getText() === 'all' && d.initializer?.getText().includes('/all-tests.json')
      )
  );
  const floorAt = ifWhere('all.size < 50');
  const coveredCheckAt = ifWhere('covered.size * 2 < all.size');

  it('the job and both collections still exist (guards against a rewrite silently dropping this)', () => {
    expect(allAt).toBeGreaterThan(-1);
    expect(coveredCheckAt).toBeGreaterThan(-1);
  });

  it('a floor on `all.size` exists, and it fails the run rather than passing it', () => {
    expect(floorAt, 'no floor check on the first collection').toBeGreaterThan(-1);
    // Guarded by an early process.exit(1), not folded into the same
    // covered-vs-all comparison (which cannot distinguish "0 orphans because
    // both collections are empty" from "0 orphans because the repo is clean").
    const floor = top[floorAt] as ts.IfStatement;
    const exits = callsTo(floor.thenStatement, 'process.exit');
    expect(exits.map(c => c.arguments[0]?.getText())).toContain('1');
  });

  it('the `all` floor is checked BEFORE the covered-vs-all comparison', () => {
    expect(floorAt).toBeGreaterThan(allAt);
    expect(floorAt).toBeLessThan(coveredCheckAt);
  });
});
