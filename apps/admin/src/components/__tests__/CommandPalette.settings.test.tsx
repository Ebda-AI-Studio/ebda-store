// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  useParams: () => ({ id: 'store-1' }),
}));
vi.mock('next-intl', () => ({ useLocale: () => 'ar' }));
vi.mock('@/i18n/useT', () => ({ useT: () => (key: string) => key }));
vi.mock('../../lib/api', () => ({ apiGet: vi.fn(async () => ({ data: null })) }));

import { CommandPalette } from '../CommandPalette';
import { mergeRegistryIntoPalette, registryPaletteItems } from '../../lib/settings-search';

const ctx = { role: 'store_admin', isFeatureEnabled: () => true, featuresLoading: false };
const nav = [{ name: 'الشحن', href: '/stores/store-1/shipping', group: 'الإعدادات' }];
const items = mergeRegistryIntoPalette(nav, registryPaletteItems('store-1', ctx, 'ar'));

function open() {
  render(<CommandPalette items={items} />);
  act(() => {
    window.dispatchEvent(new Event('force:open-search'));
  });
  return screen.getByRole('textbox');
}
const type = (input: HTMLElement, value: string) => fireEvent.change(input, { target: { value } });

beforeEach(() => push.mockReset());
afterEach(cleanup);

describe('CommandPalette: admin settings search (E23)', () => {
  it('the empty palette lists pages only, not hundreds of single settings', () => {
    open();
    expect(screen.queryByText('أيام بدون توصيل')).toBeNull();
    expect(screen.getByText('الشحن')).toBeTruthy();
  });

  it('"أيام بدون توصيل" finds the setting first and opens the page at that control', () => {
    const input = open();
    type(input, 'أيام بدون توصيل');
    const rows = screen.getAllByRole('button');
    expect(rows[0].textContent).toContain('أيام بدون توصيل');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(push).toHaveBeenCalledWith('/stores/store-1/delivery?setting=delivery.off-days');
  });

  it('an English query finds it in an Arabic UI, with the page it lives on shown as context', () => {
    const input = open();
    type(input, 'change logo');
    const first = screen.getAllByRole('button')[0];
    expect(first.textContent).toContain('الشعار');
    expect(first.textContent).toContain('هوية المتجر'); // the Branding page, as context
    fireEvent.click(first);
    expect(push).toHaveBeenCalledWith(
      '/stores/store-1/branding?tab=branding&setting=branding.logo'
    );
  });

  it('"الشحن" lists the Shipping page (the palette’s own item, with synonyms) before its settings', () => {
    const input = open();
    type(input, 'الشحن');
    const rows = screen.getAllByRole('button').map(r => r.textContent ?? '');
    expect(rows[0]).toContain('الشحن');
    expect(rows.filter(r => r.includes('الشحن')).length).toBeGreaterThan(0);
  });

  it('"دليل المقاسات" opens the size charts page', () => {
    const input = open();
    type(input, 'دليل المقاسات');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(push).toHaveBeenCalledWith('/stores/store-1/size-charts');
  });
});
