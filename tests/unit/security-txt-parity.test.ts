import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// S4-15: every public app serves the same security.txt expiry (admin/orders/web said 2027-07-15,
// marketing/help/docs 2027-09-30). RFC 9116 wants an Expires date, and a lapsed one is a trust-surface bug.
const APPS = ['admin', 'orders', 'web', 'marketing', 'help', 'docs'];
const read = (a: string) =>
  readFileSync(
    join(__dirname, '..', '..', 'apps', a, 'public', '.well-known', 'security.txt'),
    'utf8'
  );
const expires = (a: string) => /^Expires:\s*(\S+)/m.exec(read(a))?.[1] ?? '';

describe('security.txt parity (S4-15)', () => {
  it('has one Expires value across all apps', () => {
    expect(new Set(APPS.map(expires)).size).toBe(1);
  });
  it('has at least 60 days left, so a lapse fails CI before it reaches users', () => {
    const left = Date.parse(expires('web')) - Date.now();
    expect(left).toBeGreaterThan(60 * 86_400_000);
  });
});
