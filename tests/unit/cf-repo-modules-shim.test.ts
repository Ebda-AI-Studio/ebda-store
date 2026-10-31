// apps/api/src/cf/repo-modules.d.ts declares the surface of @ebda/repo + @ebda/cf-schema the Worker uses, because the
// API's tsc cannot load those ESM source packages. A name declared there but missing from the real module would typecheck
// and then fail at runtime, so every VALUE the shim exports must exist in the real module.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as repo from '../../packages/repo/src/index';
import * as schema from '../../packages/cf-schema/src/index';

const shim = fs.readFileSync(
  path.resolve(__dirname, '../../apps/api/src/cf/repo-modules.d.ts'),
  'utf8'
);
const block = (name: string) => {
  const m = shim.match(new RegExp(`declare module '${name}' \\{([\\s\\S]*?)\\n\\}`));
  expect(m, `${name} block`).not.toBeNull();
  return m![1];
};
const values = (src: string) =>
  [...src.matchAll(/^\s*export (?:function|const|class) (\w+)/gm)].map(m => m[1]);

describe('repo-modules.d.ts shim', () => {
  it('every value declared for @ebda-src/repo exists in packages/repo', () => {
    const names = values(block('@ebda-src/repo'));
    expect(names.length).toBeGreaterThan(10);
    expect(names.filter(n => !(n in repo))).toEqual([]);
  });
  it('every value declared for @ebda-src/cf-schema exists in packages/cf-schema', () => {
    const names = values(block('@ebda-src/cf-schema'));
    expect(names).toEqual(['STORE_MIGRATIONS']);
    expect(names.filter(n => !(n in schema))).toEqual([]);
  });
  it('the names are wired in wrangler, the shared vitest aliases and the DO lane', () => {
    const read = (p: string) => fs.readFileSync(path.resolve(__dirname, '../..', p), 'utf8');
    for (const n of ['@ebda-src/repo', '@ebda-src/cf-schema', '@ebda-src/prisma-meta']) {
      expect(read('apps/api/wrangler.jsonc'), `wrangler ${n}`).toContain(`"${n}"`);
      expect(read('vitest.shared.ts'), `vitest.shared ${n}`).toContain(`'${n}'`);
      expect(read('apps/api/vitest.workers-do.config.mts'), `workers-do ${n}`).toContain(`'${n}'`);
    }
  });
});
