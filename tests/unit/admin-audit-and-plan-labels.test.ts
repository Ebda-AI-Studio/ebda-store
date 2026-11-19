import { describe, it, expect } from 'vitest';
import ar from '../../apps/admin/src/i18n/messages/ar.json';
import en from '../../apps/admin/src/i18n/messages/en.json';
import {
  auditActionLabel,
  auditEntityLabel,
  auditActorName,
} from '../../apps/admin/src/lib/audit-labels';
import { tierPlanLabel } from '../../apps/admin/src/lib/plan-labels';

function lookup(messages: { audit: Record<string, unknown> }) {
  const get = (key: string): unknown =>
    key
      .split('.')
      .reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], messages.audit);
  const t = ((key: string) => String(get(key))) as ((k: string) => string) & {
    has: (k: string) => boolean;
  };
  t.has = (key: string) => typeof get(key) === 'string';
  return t;
}

describe('STORE-QA-17 audit viewer never prints raw keys', () => {
  const tAr = lookup(ar as never);
  const tEn = lookup(en as never);
  it.each(['audit.platform_viewed', 'STORE_ACCESS', 'store_access', 'product.updated'])(
    'labels %s in Arabic and English',
    key => {
      expect(auditActionLabel(key, tAr)).toMatch(/[؀-ۿ]/);
      expect(auditActionLabel(key, tAr)).not.toContain('_');
      expect(auditActionLabel(key, tEn)).not.toMatch(/[_.]/);
    }
  );
  it('unknown keys fall back to the generic label, entity too', () => {
    expect(auditActionLabel('some.new_thing', tAr)).toBe(ar.audit.actionOther);
    expect(auditEntityLabel('zzz', tAr)).toBe(ar.audit.entityOther);
    expect(auditEntityLabel('store', tAr)).toBe('متجر');
  });
  it('normalises keys and names the actor', () => {
    expect(auditActionLabel('audit.platform_viewed', tAr)).toBe(
      ar.audit.actionLabels.audit_platform_viewed
    );
    expect(auditActorName({ firstName: '', lastName: '', email: 'a@b.c' })).toBe('a@b.c');
    expect(auditActorName(null)).toBeNull();
  });
});

describe('STORE-QA-13/15/16 one plan name per tier', () => {
  it('names a legacy tier by the sold plan, never "Professional/Enterprise"', () => {
    expect(tierPlanLabel('enterprise', 'ar')).toBe('الأعمال');
    expect(tierPlanLabel('professional', 'en')).toBe('Growth');
    expect(tierPlanLabel('free', 'en')).toBe('Free');
  });
});

describe('STORE-QA-16 AI usage copy', () => {
  it('has no env var name in the admin copy and names every AI feature in Arabic', () => {
    const blob = JSON.stringify(ar.aiUsage.platform);
    expect(blob).not.toContain('AI_MODEL_RATES');
    expect(JSON.stringify(en.aiUsage.platform)).not.toContain('AI_MODEL_RATES');
    for (const k of ['categorize', 'insights-narration-segment', 'reorder-scan']) {
      expect((ar.aiUsage.platform.featureNames as Record<string, string>)[k]).toMatch(/[؀-ۿ]/);
    }
  });
});

describe('STORE-QA-1 /stores header never prints a count before the list loads', () => {
  it('the subtitle is withheld while loading or on error', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('apps/admin/src/app/stores/page.tsx', 'utf8');
    expect(src).toMatch(/subtitle=\{\s*isLoading \|\| error\s*\?\s*undefined/);
  });
});
