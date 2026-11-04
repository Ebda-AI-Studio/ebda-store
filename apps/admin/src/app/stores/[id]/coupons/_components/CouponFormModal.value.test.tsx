// @vitest-environment jsdom
/**
 * QA-COUPON-1 root cause: the coupon form turned any value the browser could not parse (Arabic-Indic digits, the Arabic
 * decimal mark, a cleared field) into a silent 0, so a "20%" coupon saved as 0%. Types a value in the REAL component and
 * asserts the payload the save would send.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { useState } from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';

vi.mock('@/i18n/useT', () => ({ useT: () => (key: string) => key }));
vi.mock('@/components/mobile/BottomSheet', () => ({
  BottomSheet: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('../../_components/ScopePicker', () => ({ ScopePicker: () => null }));

import { CouponFormModal } from './CouponFormModal';
import { INITIAL_FORM_DATA, type CouponFormData } from './types';
import { buildCouponPayload } from '../_hooks/useCoupons';

let latest: CouponFormData = INITIAL_FORM_DATA;
function Harness({ initial }: { initial?: Partial<CouponFormData> }) {
  const [data, setData] = useState<CouponFormData>({ ...INITIAL_FORM_DATA, ...initial });
  latest = data;
  return (
    <CouponFormModal
      isEditing={false}
      formData={data}
      onChange={setData}
      onSubmit={e => e.preventDefault()}
      onClose={() => undefined}
      storeId="s1"
      customerGroups={[]}
    />
  );
}
const valueInput = () => document.querySelector('input[inputmode="decimal"]') as HTMLInputElement;
const typeValue = (text: string) => fireEvent.change(valueInput(), { target: { value: text } });

afterEach(cleanup);

describe('coupon form value', () => {
  it.each([
    ['20', 20],
    ['٢٠', 20], // Arabic-Indic digits
    ['۲۰', 20], // Persian digits
    ['12.5', 12.5],
    ['١٢٫٥', 12.5], // Arabic decimal mark
    ['12,5', 12.5],
  ])('typing %s in a percentage coupon sends %d', (text, expected) => {
    render(<Harness initial={{ code: 'QA20', name: 'QA' }} />);
    typeValue(text);
    expect(buildCouponPayload(latest, 'create').value).toBe(expected);
  });

  it('a fixed coupon converts EGP to piastres from Arabic digits', () => {
    render(<Harness initial={{ type: 'fixed' }} />);
    typeValue('٥٠');
    expect(buildCouponPayload(latest, 'create').value).toBe(5000);
  });

  it('switching percentage -> fixed -> percentage keeps what was typed', () => {
    render(<Harness />);
    typeValue('20');
    fireEvent.change(document.querySelector('select') as HTMLSelectElement, {
      target: { value: 'fixed' },
    });
    fireEvent.change(document.querySelector('select') as HTMLSelectElement, {
      target: { value: 'percentage' },
    });
    expect(buildCouponPayload(latest, 'create').value).toBe(20);
  });

  it('an unreadable or empty value is never shown as a typed 0 and is sent as 0 for the API to refuse by name', () => {
    render(<Harness />);
    typeValue('abc');
    expect(valueInput().value).toBe('abc');
    expect(buildCouponPayload(latest, 'create').value).toBe(0);
    typeValue('');
    expect(valueInput().value).toBe('');
  });
});
