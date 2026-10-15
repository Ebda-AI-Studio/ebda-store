// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import React, { useState } from 'react';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import type { ProductFact } from '@ebda/shared';

let resolveTranslate: (v: unknown) => void = () => {};
vi.mock('@/lib/api', () => ({
  apiPost: () => new Promise(r => (resolveTranslate = r)),
}));
vi.mock('@/i18n/useT', () => ({ useT: () => (k: string) => k }));
vi.mock('next-intl', () => ({ useLocale: () => 'en' }));
vi.mock('@ebda/ui', () => ({
  Button: (p: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...p} />,
  Input: (p: React.InputHTMLAttributes<HTMLInputElement>) => <input {...p} />,
}));

import { FactsCard } from './FactsCard';

afterEach(cleanup);

const row = (o: Partial<ProductFact>): ProductFact => ({
  key: '',
  keyAr: '',
  value: '',
  valueAr: '',
  onCard: false,
  ...o,
});

let latest: ProductFact[] = [];
function Host() {
  const [facts, setFacts] = useState<ProductFact[]>([
    row({ key: 'Fabric', value: 'Linen', valueAr: 'كتان' }),
    row({ key: 'Care', keyAr: 'العناية', value: 'Wash', valueAr: 'غسيل' }),
  ]);
  latest = facts;
  return <FactsCard storeId="s" facts={facts} onChange={setFacts} />;
}

describe('FactsCard translate', () => {
  it('keeps an edit made to another row while translate is in flight', async () => {
    render(<Host />);
    fireEvent.click(screen.getAllByText('translate')[0]);
    // edit row 2 (value EN) before the request resolves
    fireEvent.change(screen.getAllByLabelText('valueEn')[1], { target: { value: 'Hand wash' } });
    await act(async () => resolveTranslate({ data: { translation: 'مترجم' } }));
    await waitFor(() => expect(latest[0].keyAr).toBe('مترجم'));
    expect(latest[1].value).toBe('Hand wash');
  });

  it('locks move up / move down / remove while a translation is in flight (it writes back by index)', async () => {
    render(<Host />);
    const locked = () =>
      [
        ...screen.getAllByLabelText('moveUp'),
        ...screen.getAllByLabelText('moveDown'),
        ...screen.getAllByLabelText('remove'),
      ] as HTMLButtonElement[];
    // idle: row 2 can move up, row 1 can move down, both removable
    expect(screen.getAllByLabelText('moveUp')[1]).toHaveProperty('disabled', false);
    expect(screen.getAllByLabelText('moveDown')[0]).toHaveProperty('disabled', false);
    fireEvent.click(screen.getAllByText('translate')[0]);
    expect(locked().every(b => b.disabled)).toBe(true);
    fireEvent.click(screen.getAllByLabelText('remove')[0]);
    expect(latest).toHaveLength(2);
    await act(async () => resolveTranslate({ data: { translation: 'مترجم' } }));
    await waitFor(() => expect(latest[0].keyAr).toBe('مترجم'));
    expect(screen.getAllByLabelText('moveUp')[1]).toHaveProperty('disabled', false);
    expect(screen.getAllByLabelText('remove')[0]).toHaveProperty('disabled', false);
  });
});
