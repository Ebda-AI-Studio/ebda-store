import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// MAP-HIGH A1: `apiRequest` sends `getApiUrl() + endpoint` (https://api.ebda.app), and the API mounts everything under
// /api/v1. The email-queue, sms-queue and webhook-events pages called `/admin/...` and got a 404 on every click.
const ROOT = path.resolve(__dirname, '../..');
const CALL =
  /\bapi(?:Get|Post|Put|Patch|Delete|Request|Upload)\w*\s*(?:<(?:[^<>]|<[^<>]*>)*>)?\(\s*([`'"])\/(?!api\/)([^`'"]*)/g;

export const findUnprefixed = (src: string) => [...src.matchAll(CALL)].map(m => `/${m[2]}`);

describe('admin and orders apps call the API under /api/v1', () => {
  it('the scanner flags a bare /admin path', () => {
    expect(findUnprefixed("await apiGet<{ a: 1 }>('/admin/x')")).toEqual(['/admin/x']);
    expect(findUnprefixed("await apiPost('/api/v1/admin/x', {})")).toEqual([]);
  });

  it('no admin/orders source passes a path without the /api/v1 prefix to an api helper', () => {
    const files = execFileSync('git', ['ls-files', 'apps/admin/src', 'apps/orders/src'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(f => /\.tsx?$/.test(f) && !/\.test\.|__tests__/.test(f));
    expect(files.length).toBeGreaterThan(100);
    const offenders = files.flatMap(f =>
      findUnprefixed(readFileSync(path.join(ROOT, f), 'utf8')).map(p => `${f}: ${p}`)
    );
    expect(offenders).toEqual([]);
  });
});
