/**
 * #1438: the orphan-tests job in ci.yml only guarded the SECOND vitest
 * collection (`covered.size * 2 < all.size`) against coming back broken —
 * there was no floor on the FIRST one (`all`) at all. If that collector
 * itself returns empty or near-empty, `covered` (a filtered subset of `all`)
 * is empty too, `covered.size * 2 < all.size` is `0 < 0` (false), and the job
 * falls through to computing zero orphans and printing "No orphan test
 * files" — a green pass having discovered almost nothing, indistinguishable
 * from a genuinely clean, ~395-file repo.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(__dirname, '../../.github/workflows/ci.yml'), 'utf8');

describe('#1438: orphan-tests job floors the FIRST collection too', () => {
  const allAt = src.indexOf("const all = new Set(JSON.parse(fs.readFileSync('/tmp/all-tests.json'");
  const floorAt = src.indexOf('all.size < 50');
  const coveredCheckAt = src.indexOf('covered.size * 2 < all.size');

  it('the job and both collections still exist (guards against a rewrite silently dropping this)', () => {
    expect(allAt).toBeGreaterThan(-1);
    expect(coveredCheckAt).toBeGreaterThan(-1);
  });

  it('a floor on `all.size` exists, and it fails the run rather than passing it', () => {
    expect(floorAt, 'no floor check on the first collection').toBeGreaterThan(-1);
    // Guarded by an early process.exit(1), not folded into the same
    // covered-vs-all comparison (which cannot distinguish "0 orphans because
    // both collections are empty" from "0 orphans because the repo is clean").
    const between = src.slice(floorAt, floorAt + 400);
    expect(between).toMatch(/process\.exit\(1\)/);
  });

  it('the `all` floor is checked BEFORE the covered-vs-all comparison', () => {
    expect(floorAt).toBeGreaterThan(allAt);
    expect(floorAt).toBeLessThan(coveredCheckAt);
  });
});
