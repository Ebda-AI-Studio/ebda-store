/**
 * QA-COPY-2 follow-up: the returns modal's refund guidance was Modern Standard Arabic inside an Egyptian admin. This gate
 * keeps MSA markers out of the returns strings, and pins the one phrase merchants must find on screen: every message that
 * tells them to choose the "already refunded" option quotes that option's REAL label (one message quoted a different one).
 */
import { describe, it, expect } from 'vitest';
import ar from '../../apps/admin/src/i18n/messages/ar.json';
import en from '../../apps/admin/src/i18n/messages/en.json';

const MSA =
  /سيصل|سيتم|سوف |الذين|يمكن إرسال|تُرسل|يصله|\bتم (?:إرسال|استرداد)|يجري |لا تُكمل|حدّث الصفحة قبل المحاولة|هناك |يرسل استردادًا|منح العميل|أكمل الإرجاع|راجع لوحة تحكم المزوّد، ثم/;

const walk = (o: unknown, p: string, out: Array<[string, string]> = []) => {
  if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) walk(v, `${p}.${k}`, out);
  else if (typeof o === 'string') out.push([p, o]);
  return out;
};

describe('returns copy is Egyptian', () => {
  it('no MSA marker in any Arabic returns string', () => {
    const hits = walk((ar as any).returns, 'returns')
      .filter(([, v]) => MSA.test(v))
      .map(([p, v]) => `${p}: ${v}`);
    expect(hits).toEqual([]);
  });

  it('every message that names the already-refunded option quotes its real label', () => {
    const label = (ar as any).returns.modal.refundMethodOptions.manual.label as string;
    const mentions = walk((ar as any).returns, 'returns').filter(([, v]) =>
      v.includes('تسجيل فقط')
    );
    expect(mentions.length).toBeGreaterThanOrEqual(4);
    for (const [p, v] of mentions)
      if (!p.endsWith('.manual.label')) expect(v, p).toContain(`"${label}"`);
    const enLabel = (en as any).returns.modal.refundMethodOptions.manual.label as string;
    expect(enLabel).toBe('Already refunded — record only');
  });

  it('keeps the {amount} placeholder in the wallet-share confirmation', () => {
    expect((ar as any).returns.modal.confirmOriginalWalletShare).toContain('{amount}');
  });
});
