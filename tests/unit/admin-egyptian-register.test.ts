/**
 * Audit G-8: admin chrome and errors were Modern Standard ("تعذّر ...", "لا توجد ...") while the editor was Egyptian.
 * Full sentences are Egyptian; short buttons/labels stay neutral; legal copy stays formal. These MSA openers must not
 * come back in an admin sentence.
 */
import { describe, it, expect } from 'vitest';
import ar from '../../apps/admin/src/i18n/messages/ar.json';

type Messages = { [key: string]: string | Messages };
function flatten(obj: Messages, prefix = '', out: Record<string, string> = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') flatten(v as Messages, key, out);
    else out[key] = v as string;
  }
  return out;
}
const LEGAL_KEY = /legal|terms|privacy|policy|policies|consent|dpa|notice/i;
const MSA_OPENER = /تعذّر |تعذر |الرجاء |يرجى |حدث خطأ|لم يتم |ليس لديك|لا يمكن /;

// Street slang and typos the machine rewrite produced; a business admin must not carry them (second review pass, 2026-11-03).
const SLANG_OR_TYPO =
  /نصل |سرڤر|رفرش|بايدك|براحتك|خلصانة|جايز|معذرتش|محفظناش|م ينفعش|تسطيك|مينفعش نرجع/;

describe('admin Arabic sentences are Egyptian (G-8)', () => {
  it('no message carries street slang or a known rewrite typo', () => {
    const offenders = Object.entries(flatten(ar as Messages))
      .filter(([, v]) => SLANG_OR_TYPO.test(v))
      .map(([k]) => k);
    expect(offenders).toEqual([]);
  });

  it('no non-legal message uses a Modern Standard error opener', () => {
    const offenders = Object.entries(flatten(ar as Messages))
      .filter(([k, v]) => !LEGAL_KEY.test(k) && MSA_OPENER.test(v))
      .map(([k]) => k);
    expect(offenders).toEqual([]);
  });
});
