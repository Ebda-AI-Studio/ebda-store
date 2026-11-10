// @vitest-environment jsdom
/**
 * F6 (VERIFY-SWEEP 2026-11-02): onboarding step 7 showed the raw key `onboarding.flow.template` as the Template value.
 * This renders the step with the REAL ar and en message files through next-intl and fails on any MISSING_MESSAGE, so a
 * key missing from BOTH locales (which key parity cannot see) fails here; and it pins that the row names the chosen look.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider, type IntlError } from 'next-intl';
import { getLook } from '@ebda/shared';
import ar from '../../../i18n/messages/ar.json';
import en from '../../../i18n/messages/en.json';

const apiPost = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/api', () => ({ apiPost }));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import { LiveStep } from './LiveStep';

const store = {
  id: 's1',
  name: 'متجر منى',
  slug: 'mona',
  status: 'inactive' as const,
  template: 'qamar',
  look: 'qamar.lookbook',
  host: 'mona.ebda.app',
  url: 'https://mona.ebda.app',
  planCode: 'growth',
};

afterEach(cleanup);

function renderIn(locale: 'ar' | 'en', s = store) {
  const missing: string[] = [];
  const onError = (e: IntlError) => {
    missing.push(`${e.code}: ${e.message}`);
  };
  render(
    <NextIntlClientProvider
      locale={locale}
      messages={locale === 'ar' ? ar : en}
      onError={onError}
      timeZone="Africa/Cairo"
    >
      <LiveStep store={s} productCount={1} onBack={() => {}} onGoToBilling={() => {}} />
    </NextIntlClientProvider>
  );
  return missing;
}

describe('onboarding step 7 (live) with the real messages', () => {
  for (const locale of ['ar', 'en'] as const) {
    it(`${locale}: no missing key before and after publishing, look named`, async () => {
      const missing = renderIn(locale);
      const label = locale === 'ar' ? ar.onboarding.flow.live : en.onboarding.flow.live;
      const value = screen.getByText(label.checklistTemplate).nextElementSibling!;
      expect(value.textContent).toBe(getLook('qamar.lookbook')!.name[locale]);
      apiPost.mockResolvedValueOnce({
        data: { store: { id: 's1', name: store.name, host: store.host, url: store.url } },
        error: null,
      });
      fireEvent.click(screen.getByRole('button', { name: label.publish }));
      await screen.findByText(label.doneTitle);
      expect(missing).toEqual([]);
    });
  }

  it('a store with no look yet shows its template family, never a dash or a key', () => {
    renderIn('ar', { ...store, look: null as unknown as string });
    const value = screen.getByText(ar.onboarding.flow.live.checklistTemplate).nextElementSibling!;
    expect(value.textContent).toBe('قمر');
  });
});
