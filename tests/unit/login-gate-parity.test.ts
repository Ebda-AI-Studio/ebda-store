/**
 * Ruling PASSKEY-8: passkey sign-in must keep every gate password sign-in has. Two tripwires:
 *   1. SERVICE: every `loginGate.*` call inside `AuthService.login` must also be in
 *      `PasskeyService.finishAuthentication` (one lockout counter, one active check, same key).
 *   2. ROUTE: every limiter / audit / CSRF / cookie marker in the POST /auth/login handler must have its
 *      equivalent in POST /auth/passkeys/authenticate/finish.
 * If the login route or service GAINS a gate, this goes red until passkey login gains it too (or the
 * exemption below is added with a justification a reviewer can read).
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('@api/services/redis.service', () => ({
  redis: { getClient: () => null, isAvailable: () => false },
}));

import { AuthService } from '@api/services/auth.service';
import { PasskeyService } from '@api/services/passkey.service';

const gatesIn = (fn: Function) =>
  new Set([...fn.toString().matchAll(/loginGate\.(\w+)/g)].map(m => m[1]));

/** Gates the password path uses that the passkey path legitimately does not. Empty on purpose. */
const SERVICE_EXEMPT: Record<string, string> = {};

describe('password login and passkey sign-in share their gates (PASSKEY-8)', () => {
  it('service: every loginGate call in AuthService.login is in PasskeyService.finishAuthentication', () => {
    const login = gatesIn(AuthService.login);
    const passkey = gatesIn(PasskeyService.finishAuthentication);
    expect(login.size).toBeGreaterThanOrEqual(4); // lockoutKey, assertNotLocked, recordFailure, recordSuccess, assertActive
    const missing = [...login].filter(g => !passkey.has(g) && !(g in SERVICE_EXEMPT));
    expect(missing, `passkey login lacks gate(s): ${missing.join(', ')}`).toEqual([]);
  });

  const read = (rel: string) =>
    fs.readFileSync(path.join(__dirname, '../../apps/api/src/routes', rel), 'utf8');
  const block = (src: string, start: RegExp) => {
    const i = src.search(start);
    expect(i, `route not found: ${start}`).toBeGreaterThan(-1);
    const rest = src.slice(i + 10);
    const next = rest.search(/\nrouter\.|\n\/\*\*/);
    return src.slice(i, next === -1 ? undefined : i + 10 + next);
  };
  const loginRoute = block(read('auth.routes.ts'), /router\.post\('\/login'/);
  const passkeyRoute = block(read('passkey.routes.ts'), /'\/authenticate\/finish'/);

  // login marker -> equivalent in the passkey handler
  const EQUIVALENT: Array<[string, RegExp, RegExp]> = [
    ['per-IP rate limit', /authLimiter/, /passkeyFinishLimiter/],
    ['audit success', /action: '[\w.]*login'/, /action: '[\w.]*login'/],
    ['audit failure', /action: '[\w.]*login\.failed'/, /action: '[\w.]*login\.failed'/],
    ['csrf token bound to the user', /generateCsrfToken/, /generateCsrfToken/],
    ['session cookies', /setSessionCookies/, /setSessionCookies/],
    [
      'session minting chokepoint',
      /AuthService\.(login|issueSessionFor)/,
      /AuthService\.issueSessionFor/,
    ],
  ];

  it.each(EQUIVALENT)('route: %s', (_name, inLogin, inPasskey) => {
    expect(loginRoute).toMatch(inLogin);
    expect(passkeyRoute).toMatch(inPasskey);
  });

  it('route: any NEW limiter/guard on the login handler must be mirrored (unknown identifiers fail)', () => {
    const known = new Set([
      'authLimiter',
      'auditLog',
      'generateCsrfToken',
      'setSessionCookies',
      'isPlatformOrigin',
    ]);
    const guards = [
      ...loginRoute.matchAll(/\b(\w*(?:Limiter|Guard)|require\w+|reject\w+|authenticate)\b/g),
    ].map(m => m[1]);
    const unknown = [...new Set(guards)].filter(g => !known.has(g));
    expect(
      unknown,
      `login route gained a gate passkey login may lack: ${unknown.join(', ')}`
    ).toEqual([]);
  });

  it('recovery: a password reset removes every passkey (PASSKEY-10)', () => {
    expect(AuthService.resetPassword.toString()).toMatch(/passkeyCredential\.deleteMany/);
  });
});
