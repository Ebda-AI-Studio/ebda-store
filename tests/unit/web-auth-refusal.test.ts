// @vitest-environment jsdom
/**
 * QA P2-10 / P2-3 class: storefront auth forms printed the API's English refusal ("Too many requests, please try
 * again.", "Invalid email or password") inside the Arabic UI. `authRefusalText` owns the known codes; every storefront
 * auth form that shows an API refusal goes through it, and adopts text typed before hydration (QA P2-1 class).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { authRefusalText } from '../../apps/web/src/lib/auth-refusal';
import { readTypedBeforeHydration } from '../../apps/web/src/lib/adopt-typed-before-hydration';

const ar = (_en: string, a: string) => a;

describe('authRefusalText', () => {
  it('throttle codes read Egyptian Arabic', () => {
    for (const code of ['RATE_LIMITED', 'TOO_MANY_ATTEMPTS', 'ACCOUNT_LOCKED']) {
      expect(authRefusalText({ code }, ar)).toBe('محاولات كتير. استنى كام دقيقة وجرّب تاني.');
    }
  });
  it('wrong credentials read Egyptian Arabic', () => {
    expect(authRefusalText({ code: 'INVALID_CREDENTIALS' }, ar)).toBe(
      'الإيميل أو كلمة المرور مش صح.'
    );
  });
  it('the demo refusal still wins, unknown codes fall through', () => {
    expect(authRefusalText({ code: 'DEMO_STORE' }, ar)).toBeTruthy();
    expect(authRefusalText({ code: 'SOMETHING_ELSE' }, ar)).toBeNull();
    expect(authRefusalText(null, ar)).toBeNull();
  });
});

describe('readTypedBeforeHydration', () => {
  it('returns only the non-empty named inputs', () => {
    const form = document.createElement('form');
    form.innerHTML = '<input name="email" value="a@b.test"><input name="password" value="">';
    expect(readTypedBeforeHydration(form, ['email', 'password'] as const)).toEqual({
      email: 'a@b.test',
    });
    expect(readTypedBeforeHydration(null, ['email'] as const)).toEqual({});
  });
});

describe('storefront auth forms use both', () => {
  const dir = join(__dirname, '../../apps/web/src/app/auth');
  for (const file of [
    'login/LoginClient.tsx',
    'register/RegisterClient.tsx',
    'forgot-password/ForgotPasswordClient.tsx',
  ]) {
    it(file, () => {
      const src = readFileSync(join(dir, file), 'utf8');
      expect(src).toMatch(/authRefusalText\(result\.error, t\)/);
      expect(src).toMatch(/readTypedBeforeHydration\(formRef\.current/);
      expect(src).not.toMatch(/'Failed to (login|send reset email)'/);
    });
  }
});
