/**
 * Source gate — session-cookie DELETION must reuse the SET-time attributes.
 *
 * The session cookies are written with `SameSite=None; Secure` in production
 * (AUTH_COOKIE_OPTIONS / REFRESH_COOKIE_OPTIONS) because the storefront lives
 * on a merchant domain and the API on api.ebda.app. Per RFC6265bis §5.5 —
 * and as implemented by Chrome/Firefox/Safari — a `Set-Cookie` whose same-site
 * flag is not `None` is IGNORED on a cross-site request. Clearing with a bare
 * `{ path: '/' }` was therefore a no-op for exactly the population it exists
 * for: the shopper on pecannbee.com.kw whose /auth/refresh just 401'd keeps
 * the dead `token`/`refresh_token` cookies, the cookieless guest branch in
 * csrfProtection never fires, and POST /payments/create 403s permanently. It
 * only ever worked for same-site callers (app.ebda.app), who were never
 * stuck.
 *
 * The opposite trap is maxAge: these cookies carry a 365-day maxAge, and
 * `res.cookie` derives `Expires` from it — passing the set-time options
 * through verbatim would push Expires a year into the FUTURE and re-issue the
 * cookie instead of deleting it. So the delete options must be the set options
 * MINUS maxAge, which is what clearOptionsFor exists to produce.
 *
 * A source gate rather than a request-level test because clearSessionCookies
 * is module-private and every call site (refresh-401, logout, logout-all,
 * erase) goes through this one helper.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const SOURCE = fs.readFileSync(
  path.resolve(__dirname, '../../apps/api/src/routes/auth.routes.ts'),
  'utf8'
);

/** Body of a top-level `function <name>(...) { ... }`, brace-matched. */
function functionBody(name: string): string {
  const start = SOURCE.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found in auth.routes.ts`);

  const open = SOURCE.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < SOURCE.length; i++) {
    if (SOURCE[i] === '{') depth++;
    else if (SOURCE[i] === '}' && --depth === 0) return SOURCE.slice(open + 1, i);
  }
  throw new Error(`unbalanced braces reading ${name}`);
}

describe('session-cookie deletion attributes', () => {
  it.each([
    ['token', 'AUTH_COOKIE_OPTIONS'],
    ['refresh_token', 'REFRESH_COOKIE_OPTIONS'],
  ])('clears %s with the attributes it was set with (%s)', (cookie, optionsConst) => {
    const clearBody = functionBody('clearSessionCookies');
    const call = new RegExp(`clearCookie\\(\\s*'${cookie}'\\s*,([^)]*)`).exec(clearBody);
    expect(call, `no clearCookie call for '${cookie}'`).not.toBeNull();

    // Must derive from the set-time options, so secure/sameSite/path can never
    // drift apart between the set and the delete.
    expect(call![1]).toContain(optionsConst);
    // The exact regression: a hand-written literal that omits SameSite=None.
    expect(call![1]).not.toMatch(/\{\s*path:/);
  });

  it('drops maxAge from the delete options so Expires actually expires', () => {
    const body = functionBody('clearOptionsFor');

    expect(body).toMatch(/sameSite:/);
    expect(body).toMatch(/secure:/);
    expect(body).toMatch(/path:/);
    // A surviving maxAge would override the epoch Expires clearCookie sets and
    // re-issue the cookie for another year instead of removing it.
    expect(body).not.toMatch(/maxAge/);
  });
});
