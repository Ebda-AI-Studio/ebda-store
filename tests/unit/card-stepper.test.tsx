// @vitest-environment jsdom
/**
 * Phase B4 Task 2, Ruling B4-4: the card stepper is a STATE of the one add control. It exists only
 * on a look that sets chrome.cardStepper, only for one plain line of a non-variant product, is
 * built from 44px targets with drawn signs, announces its quantity, removes the line at 1 with an
 * Undo, and says so when the server refuses another unit.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { smallTargets } from '../helpers/target-size';
import { stepperLine } from '../../apps/web/src/templates/shared/card-stepper';

const state = vi.hoisted(() => ({
  look: 'lamma.table' as string | null,
  items: [] as Array<Record<string, unknown>>,
  updateQuantity: vi.fn(async (_id: string, _q: number) => {}),
  removeItem: vi.fn(async (_id: string) => {}),
  addItem: vi.fn(async () => true),
  addToast: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, prefetch: () => {} }),
  usePathname: () => '/',
}));
vi.mock('../../apps/web/src/contexts/StoreContext', () => ({
  useStore: () => ({ store: { id: 's', look: state.look, theme: {} } }),
}));
vi.mock('../../apps/web/src/contexts/CartContext', () => ({
  useCart: () => ({
    items: state.items,
    updateQuantity: state.updateQuantity,
    removeItem: state.removeItem,
    addItem: state.addItem,
  }),
}));
vi.mock('../../apps/web/src/contexts/LanguageContext', () => ({
  useLanguage: () => ({
    language: 'ar',
    direction: 'rtl',
    isRtl: true,
    setLanguage: () => {},
    t: (_en: string, ar: string) => ar,
  }),
}));
vi.mock('@ebda/ui', async importOriginal => {
  const real = await importOriginal<Record<string, unknown>>();
  return { ...real, useToast: () => ({ addToast: state.addToast }) };
});

const { CardStepperProvider } =
  await import('../../apps/web/src/templates/shared/card-stepper-context');
const { AdaptiveAddButton, ProductCardCta } =
  await import('../../apps/web/src/templates/shared/ProductCardCta');

const line = (over: Record<string, unknown> = {}) => ({
  id: 'line-1',
  productId: 'p1',
  name: 'Okra tagine',
  nameAr: 'طاجن بامية',
  price: 12000,
  quantity: 2,
  slug: 'okra',
  ...over,
});

beforeEach(() => {
  state.look = 'lamma.table';
  state.items = [line()];
  vi.clearAllMocks();
});
afterEach(cleanup);

const withProvider = (ui: React.ReactElement) => <CardStepperProvider>{ui}</CardStepperProvider>;
const adaptive = () =>
  withProvider(<AdaptiveAddButton stepperProductId="p1" label="إضافة" onClick={() => {}} />);

describe('stepperLine (pure)', () => {
  it('is the one plain line of a non-variant product', () => {
    expect(stepperLine([line() as never], 'p1')?.id).toBe('line-1');
  });
  it('is null for no line, a variant line, an unavailable line or two lines (two notes)', () => {
    expect(stepperLine([], 'p1')).toBeNull();
    expect(stepperLine(undefined, 'p1')).toBeNull();
    expect(stepperLine([line({ variantId: 'v1' }) as never], 'p1')).toBeNull();
    expect(stepperLine([line({ unavailable: true }) as never], 'p1')).toBeNull();
    expect(
      stepperLine([line() as never, line({ id: 'line-2', note: 'بدون بصل' }) as never], 'p1')
    ).toBeNull();
    expect(stepperLine([line() as never], 'other')).toBeNull();
  });
});

describe('card stepper (Ruling B4-4)', () => {
  it('replaces the add control when the product is in the cart on a stepper look', () => {
    const { container, getByRole } = render(adaptive());
    expect(container.querySelector('[data-cta="stepper"]')).not.toBeNull();
    expect(container.querySelector('[data-cta="button"], [data-cta="add-compact"]')).toBeNull();
    expect(getByRole('status').textContent).toBe('2');
    expect(getByRole('group').getAttribute('aria-label')).toBe('كمية طاجن بامية');
  });
  it('keeps the single add control when the product is not in the cart', () => {
    state.items = [];
    const { container } = render(adaptive());
    expect(container.querySelector('[data-cta="stepper"]')).toBeNull();
    expect(container.querySelector('button')).not.toBeNull();
  });
  it('is byte-identical on a look without chrome.cardStepper and on a store with no look', () => {
    for (const look of ['qamar.atelier', null]) {
      state.look = look;
      const { container } = render(adaptive());
      expect(container.querySelector('[data-cta="stepper"]'), String(look)).toBeNull();
      cleanup();
    }
  });
  it('without the provider (checkout, captures) the card is unchanged', () => {
    const { container } = render(
      <AdaptiveAddButton stepperProductId="p1" label="إضافة" onClick={() => {}} />
    );
    expect(container.querySelector('[data-cta="stepper"]')).toBeNull();
  });
  it('a variant product never gets a stepper (it routes to its page)', () => {
    const { container } = render(
      withProvider(<ProductCardCta productId="p1" hasVariants viewHref="/products/okra" inStock />)
    );
    expect(container.querySelector('[data-cta="stepper"]')).toBeNull();
    expect(container.querySelector('[data-cta="view-variants"]')).not.toBeNull();
  });
  it('the shared ProductCardCta path shows the same stepper', () => {
    const { container } = render(withProvider(<ProductCardCta productId="p1" inStock />));
    expect(container.querySelector('[data-cta="stepper"]')).not.toBeNull();
  });
  it('both controls are >= 44px and drawn as icons, not text glyphs', () => {
    const { container } = render(adaptive());
    expect(smallTargets(container, 44)).toEqual([]);
    for (const b of Array.from(container.querySelectorAll('button')))
      expect(b.querySelector('svg'), b.getAttribute('aria-label') ?? '').not.toBeNull();
  });
  it('+ and - change the quantity by one through the cart', async () => {
    const { getByLabelText } = render(adaptive());
    fireEvent.click(getByLabelText('زيادة الكمية'));
    await waitFor(() => expect(state.updateQuantity).toHaveBeenCalledWith('line-1', 3));
    fireEvent.click(getByLabelText('إنقاص الكمية'));
    await waitFor(() => expect(state.updateQuantity).toHaveBeenCalledWith('line-1', 1));
  });
  it('- at 1 removes the line and offers Undo that puts it back', async () => {
    state.items = [line({ quantity: 1, note: 'بدون بصل' })];
    const { getByLabelText } = render(adaptive());
    fireEvent.click(getByLabelText('إنقاص الكمية'));
    await waitFor(() => expect(state.removeItem).toHaveBeenCalledWith('line-1'));
    await waitFor(() => expect(state.addToast).toHaveBeenCalled());
    const toast = state.addToast.mock.calls[0][0];
    expect(toast.action.label).toBe('تراجع');
    toast.action.onClick();
    expect(state.addItem).toHaveBeenCalledWith(expect.objectContaining({ note: 'بدون بصل' }), 1);
  });
  it('a refused + (stock or cart cap) is announced and the + stays off until the quantity changes', async () => {
    state.updateQuantity.mockRejectedValueOnce(new Error('max'));
    const { getByLabelText, getByRole } = render(adaptive());
    fireEvent.click(getByLabelText('زيادة الكمية'));
    await waitFor(() =>
      expect(getByRole('status').textContent).toContain('وصلت للحد الأقصى للكمية')
    );
    expect((getByLabelText('زيادة الكمية') as HTMLButtonElement).disabled).toBe(true);
  });
  it('the click never reaches the card link around it', () => {
    const outer = vi.fn();
    const { getByLabelText } = render(
      withProvider(
        <div onClick={outer}>
          <AdaptiveAddButton stepperProductId="p1" label="إضافة" onClick={() => {}} />
        </div>
      )
    );
    fireEvent.click(getByLabelText('زيادة الكمية'));
    expect(outer).not.toHaveBeenCalled();
  });
});
