// @vitest-environment jsdom
/**
 * "Powered by Ebda" removal (locked pricing: Basic keeps it, Growth + Business drop it).
 * The DECISION is server-side (`remove_branding` in the plan-resolved feature map, see
 * plan-gates.test.ts); these tests prove each RENDER SURFACE obeys it and fails toward
 * showing the attribution when the answer is unknown.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

const m = vi.hoisted(() => ({ isEnabled: vi.fn() }));

vi.mock('@web/contexts/LanguageContext', () => ({
  useLanguage: () => ({ t: (en: string) => en, language: 'en' }),
}));
vi.mock('@api/services/feature.service', () => ({
  featureService: { isFeatureEnabled: m.isEnabled },
}));
vi.mock('@ebda/database', () => ({ prisma: {} }));
vi.mock('@api/config', () => ({ config: {} }));
vi.mock('@api/lib/logger', () => ({ default: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('@api/services/store-mailer.service', () => ({ StoreMailer: {} }));

import { PoweredByEbda } from '../../apps/web/src/templates/shared/PoweredByEbda';
import {
  renderBrandedShell,
  storeHidesPoweredBy,
  type EmailStoreContext,
} from '@api/services/email.service';
import { renderCampaignEmail } from '@api/services/campaign.service';

const store: EmailStoreContext = { name: 'Shop', defaultLanguage: 'en' };

beforeEach(() => {
  cleanup();
  m.isEnabled.mockReset();
});

describe('storefront footer', () => {
  it('shows the attribution by default and when the plan does not remove it (Basic)', () => {
    expect(render(<PoweredByEbda />).container.textContent).toContain('Powered by');
    expect(render(<PoweredByEbda hidden={false} />).container.textContent).toContain('Powered by');
  });
  it('is gone when hidden (remove_branding resolved by the plan: Growth / Business / override)', () => {
    expect(render(<PoweredByEbda hidden />).container.textContent).toBe('');
  });
  it('every theme footer wires the plan decision into the attribution (none can drop the prop)', async () => {
    const { readFileSync } = await import('node:fs');
    for (const t of ['base']) {
      const src = readFileSync(`apps/web/src/templates/${t}/Footer.tsx`, 'utf8');
      expect(src, t).toContain('<PoweredByEbda hidden={hidePoweredBy} />');
    }
    const chrome = readFileSync('apps/web/src/components/ShopChrome.tsx', 'utf8');
    expect(chrome).toContain(
      "hidePoweredBy={store.enabledFeatures?.includes('remove_branding') === true}"
    );
  });
});

describe('customer email footer', () => {
  it('keeps the line by default and drops it with hidePoweredBy', () => {
    expect(renderBrandedShell('<p>x</p>', store)).toContain('Powered by Ebda');
    expect(renderBrandedShell('<p>x</p>', { ...store, hidePoweredBy: true })).not.toContain(
      'Powered by'
    );
  });
  it('campaign emails honour it too', () => {
    const base = {
      store: { ...store, id: 's', nameAr: null, logo: null, theme: null } as never,
      locale: 'en' as const,
      subject: 's',
      bodyHtml: '<p>b</p>',
      unsubscribeUrl: null,
    };
    expect(renderCampaignEmail(base).html).toContain('Powered by Ebda');
    expect(renderCampaignEmail({ ...base, hidePoweredBy: true }).html).not.toContain('Powered by');
  });
  it('storeHidesPoweredBy follows the feature and fails toward showing the line', async () => {
    m.isEnabled.mockResolvedValueOnce(true);
    await expect(storeHidesPoweredBy('s')).resolves.toBe(true);
    expect(m.isEnabled).toHaveBeenCalledWith('s', 'remove_branding');
    m.isEnabled.mockRejectedValueOnce(new Error('db down'));
    await expect(storeHidesPoweredBy('s')).resolves.toBe(false);
  });
});
