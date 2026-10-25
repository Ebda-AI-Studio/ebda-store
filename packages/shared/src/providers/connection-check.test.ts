import { describe, expect, it } from 'vitest';
import { describeConnectionCheck, AUTO_VERIFY_AFTER_DEFAULT } from './connection-check';

describe('describeConnectionCheck', () => {
  it('maps ok to connected', () => {
    const c = describeConnectionCheck({ ok: true, code: 'ok' });
    expect(c.status).toBe('connected');
    expect(c.ok).toBe(true);
    expect(c.messageAr).toMatch(/[؀-ۿ]/);
  });
  it.each(['bad_credentials', 'wrong_mode', 'incomplete'] as const)(
    '%s is credentials_wrong',
    code => {
      const c = describeConnectionCheck({ ok: false, code });
      expect(c.status).toBe('credentials_wrong');
      expect(c.ok).toBe(false);
    }
  );
  it('unreachable stays distinct from wrong credentials', () => {
    expect(describeConnectionCheck({ ok: false, code: 'unreachable' }).status).toBe('unreachable');
  });
  it('unknown is unrecognized, never "connected"', () => {
    const c = describeConnectionCheck({ ok: false, code: 'unknown' });
    expect(c.status).toBe('unrecognized');
    expect(c.ok).toBe(false);
  });
  it('no_check is ok but unverified with a warning', () => {
    const c = describeConnectionCheck({ ok: true, code: 'no_check' });
    expect(c.status).toBe('unverified');
    expect(c.ok).toBe(true);
    expect(c.warning).toBe(true);
  });
  it('a failing check never carries a provider message', () => {
    const c = describeConnectionCheck({
      ok: false,
      code: 'bad_credentials',
      message: 'secret sk_live_abc',
    });
    expect(JSON.stringify(c)).not.toContain('sk_live_abc');
  });
  it('auto-verify default is a small positive integer', () => {
    expect(Number.isInteger(AUTO_VERIFY_AFTER_DEFAULT)).toBe(true);
    expect(AUTO_VERIFY_AFTER_DEFAULT).toBeGreaterThan(0);
  });
});
