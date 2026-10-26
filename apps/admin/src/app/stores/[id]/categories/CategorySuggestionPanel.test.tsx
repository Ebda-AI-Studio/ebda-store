// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({ apiPost: vi.fn() }));
vi.mock('../../../../lib/api', () => api);
vi.mock('next-intl', () => {
  const t = Object.assign(
    (key: string, p?: Record<string, unknown>) => (p ? `${key}:${JSON.stringify(p)}` : key),
    {
      has: () => true,
    }
  );
  return { useTranslations: () => t, useLocale: () => 'ar' };
});

import { CategorySuggestionPanel } from './CategorySuggestionPanel';

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const proposal = {
  categories: [
    {
      name: 'Clothes',
      nameAr: 'ملابس',
      products: [
        { id: 'p1', name: 'Shirt', nameAr: 'قميص' },
        { id: 'p2', name: 'Cap', nameAr: null },
      ],
    },
    { name: 'Shoes', nameAr: 'أحذية', products: [{ id: 'p3', name: 'Sneaker', nameAr: null }] },
  ],
  unassigned: 1,
  sampled: 4,
};

describe('CategorySuggestionPanel', () => {
  it('proposes, lets the merchant edit and un-tick, and creates exactly what is on screen', async () => {
    const onCreated = vi.fn();
    api.apiPost
      .mockResolvedValueOnce({ data: proposal })
      .mockResolvedValueOnce({ data: { created: [] } });
    render(<CategorySuggestionPanel storeId="s1" onCreated={onCreated} />);
    fireEvent.click(screen.getByTestId('category-suggest-ask'));
    await screen.findByTestId('category-suggest-review');
    expect(api.apiPost.mock.calls[0][0]).toBe('/api/v1/stores/s1/ai/suggest-store-categories');

    const [firstEn] = screen.getAllByDisplayValue('Clothes');
    fireEvent.change(firstEn, { target: { value: 'Apparel' } });
    fireEvent.click(screen.getAllByRole('button').find(b => b.textContent === 'remove')!); // drops the first category? no: first row
    fireEvent.click(screen.getByTestId('category-suggest-apply'));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    const body = api.apiPost.mock.calls[1][1] as {
      categories: Array<{ name: string; productIds: string[] }>;
    };
    expect(api.apiPost.mock.calls[1][0]).toBe('/api/v1/stores/s1/ai/apply-store-categories');
    expect(body.categories).toEqual([{ name: 'Shoes', nameAr: 'أحذية', productIds: ['p3'] }]);
  });

  it('maps the API codes to plain messages and never shows a review for an empty proposal', async () => {
    api.apiPost.mockResolvedValueOnce({ error: { code: 'NO_PRODUCTS' } });
    render(<CategorySuggestionPanel storeId="s1" onCreated={() => {}} />);
    fireEvent.click(screen.getByTestId('category-suggest-ask'));
    expect((await screen.findByRole('alert')).textContent).toBe('noProducts');
    api.apiPost.mockResolvedValueOnce({ error: { code: 'AI_DISABLED_BY_MERCHANT' } });
    fireEvent.click(screen.getByTestId('category-suggest-ask'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('aiOff'));
    api.apiPost.mockResolvedValueOnce({ data: { categories: [], unassigned: 0, sampled: 2 } });
    fireEvent.click(screen.getByTestId('category-suggest-ask'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('none'));
    expect(screen.queryByTestId('category-suggest-review')).toBeNull();
  });
});
