/**
 * ONE password policy (2026-11-17). The storefront register form checked only "8+" while the API also required upper,
 * lower, digit and symbol, and a 400 told the shopper nothing. These tests pin: the rules, that the API schemas, the
 * accounts schema and the client validators all derive from the SAME module, and that no copy of the rule regexes is
 * left behind in any consumer.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  addPasswordPolicyIssues,
  failedPasswordRules,
  isPasswordPolicyMet,
  passwordFailureSentence,
  passwordRuleResults,
  passwordUnmetSentence,
} from '../../packages/shared/src/password-policy';
import { passwordSchema } from '../../apps/api/src/services/merchant-signup.service';
import { isStrongPassword } from '../../apps/admin/src/lib/onboarding-validation';

const PASSWORD_RULES = passwordRuleResults('').map(r => r.rule);
const root = join(__dirname, '..', '..');
const src = (p: string) => readFileSync(join(root, p), 'utf8');

const CASES: Array<[string, string]> = [
  ['Abc123!', 'length'],
  ['abcd123!', 'upper'],
  ['ABCD123!', 'lower'],
  ['Abcdefg!', 'number'],
  ['Abcd1234', 'special'],
];

describe('shared password policy', () => {
  it('keeps the five existing rules (strength is unchanged by this fix)', () => {
    expect(PASSWORD_RULES.map(r => r.id)).toEqual([
      'length',
      'upper',
      'lower',
      'number',
      'special',
    ]);
    expect(isPasswordPolicyMet('Abcd123!')).toBe(true);
    expect(isPasswordPolicyMet('Abcd123')).toBe(false);
  });

  it.each(CASES)(
    '%s fails exactly the %s rule, in the policy, the API schema and the admin check',
    (pw, id) => {
      expect(failedPasswordRules(pw).map(r => r.id)).toEqual([id]);
      const parsed = passwordSchema.safeParse(pw);
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues.map(i => i.message)).toEqual([
          PASSWORD_RULES.find(r => r.id === id)!.apiMessage,
        ]);
      }
      expect(isStrongPassword(pw)).toBe(false);
    }
  );

  it('the API reports EVERY unmet rule at once (details.password[])', () => {
    const r = z.string().superRefine(addPasswordPolicyIssues).safeParse('abc');
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues).toHaveLength(4);
  });

  it('every rule has an Egyptian-Arabic label and an English one, and the API message maps back to them', () => {
    for (const rule of PASSWORD_RULES) {
      expect(rule.ar).toMatch(/[؀-ۿ]/);
      expect(passwordFailureSentence([rule.apiMessage], 'ar')).toContain(rule.ar);
      expect(passwordFailureSentence([rule.apiMessage], 'en')).toContain(rule.en);
    }
    expect(passwordFailureSentence(['Invalid request data'], 'ar')).toBeNull();
    expect(passwordUnmetSentence('Abcd123!', 'ar')).toBeNull();
  });
});

describe('every consumer uses the shared policy (no private copy)', () => {
  const consumers = [
    'apps/api/src/routes/auth.routes.ts',
    'apps/api/src/services/merchant-signup.service.ts',
    'apps/accounts/src/password.ts',
    'apps/admin/src/lib/onboarding-validation.ts',
    'apps/web/src/app/auth/register/validate-registration.ts',
    'apps/web/src/app/auth/reset-password/ResetPasswordClient.tsx',
    'apps/web/src/app/account/profile/ProfileClient.tsx',
    'apps/web/src/app/account/settings/SettingsClient.tsx',
  ];
  it.each(consumers)('%s imports the shared module and carries no password regex', file => {
    const text = src(file);
    expect(text).toMatch(
      /password-policy|addPasswordPolicyIssues|isPasswordPolicyMet|passwordUnmetSentence/
    );
    expect(text).not.toMatch(/\/\[A-Z\]\/|\/\[a-z\]\/|\/\[0-9\]\/|\/\[\^A-Za-z0-9\]\//);
  });

  it('every form that sets a password renders the live checklist', () => {
    for (const f of [
      'apps/web/src/app/auth/register/RegisterClient.tsx',
      'apps/web/src/app/auth/reset-password/ResetPasswordClient.tsx',
      'apps/web/src/app/account/profile/ProfileClient.tsx',
      'apps/web/src/app/account/settings/SettingsClient.tsx',
      'apps/admin/src/app/signup/page.tsx',
      'apps/admin/src/app/reset-password/page.tsx',
    ]) {
      expect(src(f), f).toMatch(/PasswordChecklist|PasswordRules/);
    }
  });
});
