/**
 * THE password policy. One module for the API schemas (register, change-password, merchant signup / reset, the
 * accounts service) and every client form that SETS a password, so a form can never promise less than the server
 * enforces (Ebda 2026-11-17: the storefront only checked "8+" while the API also required upper, lower, digit and
 * symbol, and the shopper was told nothing about which rule failed).
 *
 * Dependency-free on purpose: `apps/accounts` imports this file by relative path and must not pull the rest of
 * `@ebda/shared` into its Worker bundle.
 *
 * The policy strength itself is Ahmad's call (a NIST-style length-first policy is the alternative); changing it means
 * editing `PASSWORD_RULES` here and nothing else.
 */

const PASSWORD_MIN_LENGTH = 8;

type PasswordRuleId = 'length' | 'upper' | 'lower' | 'number' | 'special';

interface PasswordRule {
  id: PasswordRuleId;
  test: (password: string) => boolean;
  /** Short checklist label, English. */
  en: string;
  /** Short checklist label, Egyptian Arabic. */
  ar: string;
  /** The exact English message the API puts in `error.details.<field>[]` (clients map it back to `en`/`ar`). */
  apiMessage: string;
}

const PASSWORD_RULES: readonly PasswordRule[] = [
  {
    id: 'length',
    test: p => p.length >= PASSWORD_MIN_LENGTH,
    en: `${PASSWORD_MIN_LENGTH} characters or more`,
    ar: `${PASSWORD_MIN_LENGTH} حروف أو أكتر`,
    apiMessage: `Password must be at least ${PASSWORD_MIN_LENGTH} characters`,
  },
  {
    id: 'upper',
    test: p => /[A-Z]/.test(p),
    en: 'An uppercase letter (A-Z)',
    ar: 'حرف إنجليزي كبير (A-Z)',
    apiMessage: 'Password must contain at least one uppercase letter',
  },
  {
    id: 'lower',
    test: p => /[a-z]/.test(p),
    en: 'A lowercase letter (a-z)',
    ar: 'حرف إنجليزي صغير (a-z)',
    apiMessage: 'Password must contain at least one lowercase letter',
  },
  {
    id: 'number',
    test: p => /[0-9]/.test(p),
    en: 'A number (0-9)',
    ar: 'رقم واحد على الأقل (0-9)',
    apiMessage: 'Password must contain at least one number',
  },
  {
    id: 'special',
    test: p => /[^A-Za-z0-9]/.test(p),
    en: 'A symbol such as ! @ # $',
    ar: 'رمز واحد على الأقل زي ! @ # $',
    apiMessage: 'Password must contain at least one special character',
  },
];

export const PASSWORD_POLICY_TITLE = {
  en: 'Your password needs:',
  ar: 'كلمة المرور لازم يكون فيها:',
} as const;

interface PasswordRuleResult {
  rule: PasswordRule;
  met: boolean;
}

/** Every rule with whether `password` meets it (drives the live checklist). */
export function passwordRuleResults(password: string): PasswordRuleResult[] {
  return PASSWORD_RULES.map(rule => ({ rule, met: rule.test(password) }));
}

/** The rules `password` does NOT meet, in policy order. */
export function failedPasswordRules(password: string): PasswordRule[] {
  return PASSWORD_RULES.filter(rule => !rule.test(password));
}

export function isPasswordPolicyMet(password: string): boolean {
  return PASSWORD_RULES.every(rule => rule.test(password));
}

/** Structural slice of a zod refinement context (v3 and v4 both satisfy it). */
interface IssueSink {
  addIssue(issue: { code: 'custom'; message: string }): void;
}

/**
 * `z.string().max(n).superRefine(addPasswordPolicyIssues)`: one issue per failed rule, each carrying the rule's
 * `apiMessage`, so the API's `details.password[]` lists EVERY unmet rule at once.
 */
export function addPasswordPolicyIssues(password: string, ctx: IssueSink): void {
  for (const rule of failedPasswordRules(password)) {
    ctx.addIssue({ code: 'custom', message: rule.apiMessage });
  }
}

/** The rule an API `details` message belongs to, or undefined for any other message. */
function passwordRuleForApiMessage(message: string): PasswordRule | undefined {
  return PASSWORD_RULES.find(rule => rule.apiMessage === message);
}

function sentenceForRules(rules: readonly PasswordRule[], lang: 'en' | 'ar'): string | null {
  if (rules.length === 0) return null;
  return lang === 'ar'
    ? `كلمة المرور لسه محتاجة: ${rules.map(r => r.ar).join('، ')}.`
    : `Your password still needs: ${rules.map(r => r.en).join(', ')}.`;
}

/**
 * One sentence naming what a refused password still lacks, in `lang`, from the API's `details` messages. Null when
 * none of the messages is a password rule (the caller keeps its own fallback).
 */
export function passwordFailureSentence(
  messages: readonly unknown[],
  lang: 'en' | 'ar'
): string | null {
  const rules = messages
    .map(m => (typeof m === 'string' ? passwordRuleForApiMessage(m) : undefined))
    .filter((r): r is PasswordRule => r !== undefined);
  return sentenceForRules(rules, lang);
}

/** The same sentence computed client-side from the typed password (null when the policy is met). */
export function passwordUnmetSentence(password: string, lang: 'en' | 'ar'): string | null {
  return sentenceForRules(failedPasswordRules(password), lang);
}
