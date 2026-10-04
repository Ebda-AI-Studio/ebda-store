// @vitest-environment jsdom
/**
 * SP8: Branding → Contact edits the store WhatsApp number (Egyptian mobile
 * validation) and the three free-tier wa.me toggles. Toggles are locked off
 * until a valid number exists and default ON once it does.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

vi.mock('@/i18n/useT', () => ({
  useT: (ns?: string) => (key: string) => `${ns ? `${ns}.` : ''}${key}`,
}));

import { ContactInfoTab } from './ContactInfoTab';
import type { StoreBranding } from './types';

const branding = (over: Partial<StoreBranding> = {}) =>
  ({ theme: {}, whatsapp: '', ...over }) as unknown as StoreBranding;

afterEach(cleanup);

describe('ContactInfoTab WhatsApp settings', () => {
  it('no number: toggles disabled with a hint', () => {
    render(<ContactInfoTab branding={branding()} onChange={() => {}} />);
    expect(screen.getByText('branding.contact.waMeNeedsNumber')).toBeTruthy();
    const boxes = within(screen.getByTestId('wa-me-toggles')).getAllByRole(
      'checkbox'
    ) as HTMLInputElement[];
    expect(boxes).toHaveLength(3);
    expect(boxes.every(b => b.disabled && !b.checked)).toBe(true);
  });

  it('invalid number shows the Egyptian-mobile error', () => {
    render(<ContactInfoTab branding={branding({ whatsapp: '12345' })} onChange={() => {}} />);
    expect(screen.getByRole('alert').textContent).toBe('branding.contact.whatsappInvalid');
  });

  it('valid number: toggles default ON; unchecking writes false to the theme', () => {
    const onChange = vi.fn();
    render(<ContactInfoTab branding={branding({ whatsapp: '01012345678' })} onChange={onChange} />);
    const boxes = within(screen.getByTestId('wa-me-toggles')).getAllByRole(
      'checkbox'
    ) as HTMLInputElement[];
    expect(boxes.every(b => !b.disabled && b.checked)).toBe(true);
    fireEvent.click(screen.getByLabelText('branding.contact.waMeCodConfirm'));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ theme: expect.objectContaining({ waMeCodConfirm: false }) })
    );
  });
});
