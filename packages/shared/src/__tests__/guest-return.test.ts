import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { guestReturnCustomerId, isGuestReturnCustomer } from '../guest-return';

// GUEST-RET-1. packages/repo cannot import @ebda/shared, so do/returns.ts keeps a copy of the marker helpers: they must agree.
const ROOT = join(__dirname, '../../../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('guest return marker', () => {
  it('round-trips and rejects real ids', () => {
    expect(isGuestReturnCustomer(guestReturnCustomerId('o1'))).toBe(true);
    for (const v of ['u-1', '', null, undefined, 5]) expect(isGuestReturnCustomer(v)).toBe(false);
  });
  it('the DO copy in packages/repo uses the same marker', () => {
    expect(read('packages/repo/src/do/returns.ts')).toContain(
      "const GUEST_RETURN_PREFIX = 'guest:';"
    );
  });
});

// Guard: a read of a RETURN's customer_id / customerId must go through the helper or an explicit equality with a user id,
// so a new reader cannot treat the `guest:<orderId>` marker as an account (wallet credit, email, socket, profile lookup).
// Add a line to ALLOWED only after deciding what the marker does at that site.
const files = (dir: string): string[] =>
  readdirSync(join(ROOT, dir)).flatMap(f => {
    const rel = `${dir}/${f}`;
    return statSync(join(ROOT, rel)).isDirectory() ? files(rel) : /\.tsx?$/.test(f) ? [rel] : [];
  });
const READ =
  /\b(?:ret|returnRequest|updatedReturn|found|record)\.(?:customer_id|customerId)\b|plan\.customerId/;
const ALLOWED: Array<[string, RegExp]> = [
  // an explicit equality with the signed-in user's id: the marker never equals a real users.id
  ['apps/api/src/routes/return.routes.ts', /[!=]==\s*req\.user!?\.userId/],
  // the helper itself and the places that already decide what the marker does
  ['packages/repo/src/do/returns.ts', /isGuestReturnCustomer\(ret\.customer_id\)/],
  ['packages/repo/src/do/returns.ts', /customerId: ret\.customer_id as string/], // ReturnPlan; guarded by GUEST_STORE_CREDIT, no wallet leg for a guest
  ['packages/repo/src/do/returns.ts', /customerId: plan\.customerId/], // wallet credit legs: unreachable for a guest (store credit refused, walletShare 0)
  ['apps/api/src/services/return.service.ts', /isGuestReturnCustomer\(/],
  ['apps/api/src/services/return.service.ts', /rows\.map\(r => r\.customerId\)/],
  ['apps/api/src/services/return.service.ts', /byId\.get\(r\.customerId\)/],
  ['apps/api/src/services/return.service.ts', /returnRequest\.customerId/], // complete(): wallet legs, same reasoning as the DO plan
  ['apps/api/src/services/return.service.ts', /updatedReturn\.customerId/], // behind !isGuestReturnCustomer
];
describe('returns customer_id readers', () => {
  it('every read of a return customer id is the helper, an allow-listed site, or absent', () => {
    const bad: string[] = [];
    for (const f of [...files('packages/repo/src'), ...files('apps/api/src')].filter(f =>
      /return/i.test(f.split('/').pop() ?? '')
    )) {
      read(f)
        .split('\n')
        .forEach((line, i) => {
          if (!READ.test(line)) return;
          const ok = ALLOWED.some(([file, re]) => file === f && re.test(line));
          if (!ok) bad.push(`${f}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(bad).toEqual([]);
  });
});
