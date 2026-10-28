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
const rows = [...index.matchAll(/^\|\s*(.+?)\s*\|.*\|\s*\[([^\]]+)\.md\]\(([^)]+)\)\s*\|$/gm)].map(
  m => ({
    id: m[1],
    file: m[2],
    href: m[3],
  })
);

describe('rulings index (docs/rulings/README.md)', () => {
  it('scans real data (not an empty-set pass)', () => {
    expect(rulingFiles.length).toBeGreaterThan(1000);
    expect(rows.length).toBeGreaterThan(1000);
  });

  it('every docs/rulings/*.md is listed in the index', () => {
    const listed = new Set(rows.map(r => r.file));
    expect(rulingFiles.filter(f => !listed.has(f))).toEqual([]);
  });

  it('every index row links an existing ruling file, once', () => {
    expect(
      rows.filter(r => r.href !== `${r.file}.md` || !existsSync(path.join(DIR, r.href)))
    ).toEqual([]);
    const seen = new Set<string>();
    const dup = rows.filter(r => (seen.has(r.file) ? true : (seen.add(r.file), false)));
    expect(dup).toEqual([]);
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
