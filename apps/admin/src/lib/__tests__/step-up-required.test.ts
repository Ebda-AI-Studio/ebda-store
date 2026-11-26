// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { handleStepUpRequired } from '../session-ended';
import { ERROR_AR, ERROR_EN, resolveErrorMessage } from '../error-messages';

/** TEN-4: the API answers 403 STEP_UP_REQUIRED when the sign-in is older than 30 min; the admin sends the person to sign in again. */
describe('STEP_UP_REQUIRED handling', () => {
  it('signs out, then goes to /login with the page as returnTo and stepup=1', async () => {
    const order: string[] = [];
    const assign = vi.fn((u: string) => void order.push(`assign:${u}`));
    await handleStepUpRequired(async () => void order.push('signout'), {
      pathname: '/stores/s1/staff',
      search: '?tab=1',
      assign,
    });
    expect(order).toEqual([
      'signout',
      `assign:/login?returnTo=${encodeURIComponent('/stores/s1/staff?tab=1')}&stepup=1`,
    ]);
  });

  it('has an Egyptian-Arabic and an English message for the code', () => {
    expect(ERROR_AR.STEP_UP_REQUIRED).toMatch(/[؀-ۿ]/);
    expect(ERROR_EN.STEP_UP_REQUIRED).toMatch(/^[A-Za-z]/);
    expect(
      resolveErrorMessage({
        code: 'STEP_UP_REQUIRED',
        status: 403,
        serverMessage: 'x',
        locale: 'ar',
      })
    ).toBe(ERROR_AR.STEP_UP_REQUIRED);
  });

  it('apiRequest wires the code to the handler, and the login page shows the note (both locales)', () => {
    const root = path.resolve(__dirname, '../..');
    expect(readFileSync(path.join(root, 'lib/api.ts'), 'utf8')).toMatch(
      /errCode === 'STEP_UP_REQUIRED'[\s\S]{0,120}handleStepUpRequired/
    );
    for (const l of ['en', 'ar']) {
      const j = JSON.parse(readFileSync(path.join(root, `i18n/messages/${l}.json`), 'utf8'));
      expect(typeof j.auth.login.stepUpRequired).toBe('string');
    }
  });
});
