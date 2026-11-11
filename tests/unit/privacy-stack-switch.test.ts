import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LEGAL_POLICIES,
  PRIVACY_STACK,
  currentLegalVersion,
} from '../../packages/shared/src/legal';
import { POST_CUTOVER } from '../../apps/marketing/src/lib/legal-privacy-stack';

/**
 * DOC-2: the privacy policy's processors/transfers sections switch from the current stack to the post-Cloudflare-cutover
 * text with ONE constant (PRIVACY_STACK in packages/shared/src/legal), and the switch needs a matching version bump.
 */
const RETIRED = /Neon|Resend|Inngest/;

describe('privacy policy processor stack switch', () => {
  afterEach(() => vi.resetModules());

  it('the post-cutover text names Cloudflare as the processor and none of the retired providers', () => {
    for (const lang of ['en', 'ar'] as const) {
      const t = [...POST_CUTOVER[lang].providers, ...POST_CUTOVER[lang].transfers].join('\n');
      expect(t).not.toMatch(RETIRED);
      for (const name of ['Cloudflare', 'Meta', 'Kashier', 'Google Gemini', 'Workers AI'])
        expect(t, `${lang} ${name}`).toContain(name);
      expect(t).toContain('InstaPay'.replace('InstaPay', lang === 'en' ? 'InstaPay' : 'إنستاباي')); // launch payment method
    }
  });

  it('the live text (PRIVACY_STACK = current) still describes today: it names the current stack', async () => {
    const { LEGAL_EN } = await import('../../apps/marketing/src/lib/legal-en');
    const s5 = LEGAL_EN.privacy.sections.find(s => s.h.startsWith('5.'))!;
    if (PRIVACY_STACK === 'current') expect(s5.p.join(' ')).toMatch(/Neon/);
  });

  it('flipping the constant to cloudflare renders the post-cutover sections in both languages', async () => {
    vi.resetModules();
    vi.doMock('@ebda/shared/legal', async orig => ({
      ...(await orig<typeof import('../../packages/shared/src/legal')>()),
      PRIVACY_STACK: 'cloudflare',
    }));
    const { LEGAL_EN } = await import('../../apps/marketing/src/lib/legal-en');
    const { LEGAL_AR } = await import('../../apps/marketing/src/lib/legal-ar');
    for (const [pages, lang] of [
      [LEGAL_EN, 'en'],
      [LEGAL_AR, 'ar'],
    ] as const) {
      const sec = pages.privacy.sections;
      expect(sec.find(s => s.h.startsWith('5.'))!.p).toEqual([...POST_CUTOVER[lang].providers]);
      expect(sec.find(s => s.h.startsWith('6.'))!.p).toEqual([...POST_CUTOVER[lang].transfers]);
    }
    vi.doUnmock('@ebda/shared/legal');
  });

  it('a cloudflare switch needs a material privacy entry of 1.2 or later (the policy changes the day the processors do)', () => {
    if (PRIVACY_STACK === 'cloudflare') {
      // the switch itself shipped as a material entry >= 1.2; a later NON-material wording fix (e.g. 1.3,
      // LEGAL-NAMES-1) may follow it, so look for the material switch entry in the history, not only at the tip
      const atLeast12 = (v: { version: string }) =>
        Number(v.version.split('.')[1]) >= 2 || Number(v.version.split('.')[0]) >= 2;
      expect(LEGAL_POLICIES.privacy.history.some(v => atLeast12(v) && v.material)).toBe(true);
      expect(atLeast12(currentLegalVersion(LEGAL_POLICIES, 'privacy'))).toBe(true);
    } else {
      expect(PRIVACY_STACK).toBe('current');
    }
  });
});
