// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../../../../../../../i18n/messages/en.json';
import ar from '../../../../../../../i18n/messages/ar.json';
import { ReviewRow } from './ReviewRow';
import { egpToMinor, minorToEgp, type ReviewItem } from '../../_lib/api';

vi.mock('../../_lib/api', async orig => {
  const real = await orig<typeof import('../../_lib/api')>();
  return { ...real, openSource: vi.fn() };
});

const base: ReviewItem = {
  id: 'i1',
  fileId: 'f1',
  status: 'pending',
  name: 'Tea',
  nameAr: 'شاي',
  description: null,
  descriptionAr: null,
  priceMinor: 15000,
  compareAtMinor: null,
  sku: null,
  categoryName: null,
  categoryId: null,
  tags: [],
  variants: [],
  confidence: 0.9,
  flags: [],
  acknowledged: [],
  sourceText: null,
  editedFields: [],
  productId: null,
  createErrorCode: null,
};

function ui(
  item: Partial<ReviewItem>,
  onPatch = vi.fn(async () => null),
  locale: 'en' | 'ar' = 'en'
) {
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : ar}>
      <ul>
        <ReviewRow
          item={{ ...base, ...item }}
          categories={[]}
          onPatch={onPatch}
          onOpenSource={vi.fn()}
          locked={false}
        />
      </ul>
    </NextIntlClientProvider>
  );
}

afterEach(cleanup);

describe('ReviewRow', () => {
  it('shows the confidence band as text, bands at 0.85 / 0.60', () => {
    ui({ confidence: 0.85 });
    expect(screen.getByText('Clear')).toBeTruthy();
    cleanup();
    ui({ confidence: 0.84 });
    expect(screen.getByText('Check')).toBeTruthy();
    cleanup();
    ui({ confidence: 0.59 });
    expect(screen.getByText('Unsure')).toBeTruthy();
  });

  it('accept stays disabled until a blocking flag is ticked, then sends the acknowledgement', async () => {
    const onPatch = vi.fn(async () => null);
    ui({ flags: ['price_from'] }, onPatch);
    const accept = screen.getByRole('button', { name: 'Accept' }) as HTMLButtonElement;
    expect(accept.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: /starting price/i }));
    expect(accept.disabled).toBe(false);
    fireEvent.click(accept);
    await waitFor(() =>
      expect(onPatch).toHaveBeenCalledWith('i1', {
        status: 'accepted',
        acknowledge: ['price_from'],
      })
    );
  });

  it('a typed price 150.5 is saved as 15050 piastres on blur', async () => {
    const onPatch = vi.fn(async () => null);
    ui({}, onPatch);
    const price = screen.getByLabelText('Price (EGP)');
    fireEvent.change(price, { target: { value: '150.5' } });
    fireEvent.blur(price);
    await waitFor(() => expect(onPatch).toHaveBeenCalledWith('i1', { priceMinor: 15050 }));
  });

  it('renders in Arabic with labels, and flags use words', () => {
    ui({ flags: ['phone_removed'] }, undefined, 'ar');
    expect(screen.getByText('رقم تليفون اتشال')).toBeTruthy();
    expect(screen.getByLabelText('السعر (جنيه)')).toBeTruthy();
  });

  it('a created item is locked and shows the draft state', () => {
    ui({ status: 'created' });
    expect(screen.getByText('Draft created')).toBeTruthy();
    expect((screen.getByLabelText('Price (EGP)') as HTMLInputElement).disabled).toBe(true);
  });
});

describe('price helpers', () => {
  it('converts EGP text to piastres, Arabic digits included; bad input is undefined', () => {
    expect(egpToMinor('150.5')).toBe(15050);
    expect(egpToMinor('١٥٠')).toBe(15000);
    expect(egpToMinor('')).toBeNull();
    expect(egpToMinor('abc')).toBeUndefined();
    expect(egpToMinor('1.234')).toBeUndefined();
    expect(minorToEgp(15050)).toBe('150.5');
  });
});
