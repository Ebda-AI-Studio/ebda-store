import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');
const DIR = path.join(ROOT, 'docs/rulings');
const rulingFiles = readdirSync(DIR)
  .filter(f => f.endsWith('.md') && f !== 'README.md')
  .map(f => f.slice(0, -3));
const index = readFileSync(path.join(DIR, 'README.md'), 'utf8');

// Ruling RULINGS-INDEX-1: the folder IS the index. README.md is static (no table, no count), so two
// PRs that each add a ruling touch disjoint files and never conflict.
describe('rulings index (docs/rulings/)', () => {
  it('scans real data (not an empty-set pass)', () => {
    expect(rulingFiles.length).toBeGreaterThan(1000);
  });

  it('every entry in docs/rulings/ is a ruling markdown file with a safe <ID>.md name', () => {
    const others = readdirSync(DIR).filter(f => !f.endsWith('.md'));
    expect(others).toEqual([]);
    expect(rulingFiles.filter(id => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id))).toEqual([]);
  });

  it('every ruling file has content', () => {
    expect(
      rulingFiles.filter(id => readFileSync(path.join(DIR, `${id}.md`), 'utf8').trim() === '')
    ).toEqual([]);
  });

  it('ruling IDs are unique, case-insensitively (case-folding checkouts)', () => {
    const seen = new Set<string>();
    const dup = rulingFiles.filter(id => {
      const k = id.toLowerCase();
      return seen.has(k) ? true : (seen.add(k), false);
    });
    expect(dup).toEqual([]);
  });

  it('README.md stays static: no table rows and no hand-typed count (the shared edit stays gone)', () => {
    expect(index.split('\n').filter(l => /^\s*\|/.test(l))).toEqual([]);
    expect(index).not.toMatch(/^\s*\d+\s+rulings?\b/im);
    expect(index).toContain('RULINGS-INDEX-1');
  });

  it('the legacy ledger stays a pointer (new rulings never append to it)', () => {
    const legacy = readFileSync(path.join(ROOT, 'docs/RULINGS.md'), 'utf8');
    expect(legacy.split('\n').length).toBeLessThan(20);
    expect(legacy).toContain('rulings/README.md');
  });
});

describe('docs index (docs/README.md)', () => {
  const readme = readFileSync(path.join(ROOT, 'docs/README.md'), 'utf8');
  it('links the rulings index', () => {
    expect(readme).toContain('(rulings/README.md)');
  });
  it('lists every tracked doc under docs/ (md/html/json/yaml, rulings excluded)', () => {
    const tracked = execSync('git ls-files docs', { cwd: ROOT, encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter(f => /\.(md|html|json|yaml)$/.test(f))
      .filter(f => !f.startsWith('docs/rulings/') && f !== 'docs/README.md');
    expect(tracked.filter(f => !readme.includes(`(${f.slice(5)})`))).toEqual([]);
  });
  it('every link in the docs index resolves', () => {
    const missing = [...readme.matchAll(/\]\(([^)#]+)\)/g)]
      .map(m => m[1])
      .filter(h => !existsSync(path.join(ROOT, 'docs', h)));
    expect(missing).toEqual([]);
  });
});
