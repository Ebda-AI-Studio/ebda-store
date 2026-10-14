/**
 * The workspace packages are `@ebda/*`. The inherited `@force/` npm scope must
 * not reappear in any tracked file (imports, package.json, configs, workflows,
 * docs). Excluded: the lockfile is generated, graphify-out/ is generated, and
 * this file spells the forbidden scope out.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const SELF = 'tests/unit/no-force-package-scope.test.ts';
const FORBIDDEN = '@force' + '/';

describe('no @force/ package scope', () => {
  it('no tracked file references the @force/ scope', () => {
    const files = execFileSync('git', ['ls-files', '-z'], {
      cwd: ROOT,
      maxBuffer: 64 * 1024 * 1024,
    })
      .toString()
      .split('\0')
      .filter(Boolean)
      .filter(f => f !== SELF && f !== 'package-lock.json' && !f.startsWith('graphify-out/'));
    const hits: string[] = [];
    for (const f of files) {
      let text: string;
      try {
        text = readFileSync(path.join(ROOT, f), 'utf8');
      } catch {
        continue; // deleted / unreadable in a dirty tree
      }
      if (text.includes('\0')) continue; // binary
      if (text.includes(FORBIDDEN) || text.includes('@force\\/')) hits.push(f);
    }
    expect(hits).toEqual([]);
  });
});
