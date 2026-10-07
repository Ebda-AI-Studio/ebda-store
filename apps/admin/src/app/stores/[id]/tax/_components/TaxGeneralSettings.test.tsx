// @vitest-environment jsdom
/** VAT gate (ruling TAX-2): the enable toggle is locked until the VAT registration is verified. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('next-intl', () => {
  const t = Object.assign((key: string) => key, { has: () => true });
  return { useTranslations: () => t, useLocale: () => 'en' };
});

import { TaxGeneralSettings } from './TaxGeneralSettings';

afterEach(cleanup);

const base = {
  savingSettings: false,
  onSettingsChange: vi.fn(),
  onSaveSettings: vi.fn(),
};

describe('TaxGeneralSettings VAT gate', () => {
  it('disables the enable toggle and links to #vat-registration when not verified', () => {
    render(
      <TaxGeneralSettings
        {...base}
        vatVerified={false}
        settings={{ taxEnabled: false, taxIncludedInPrice: false }}
      />
    );
    const [enable] = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(enable.disabled).toBe(true);
    const link = screen.getByText('enable.needsVerificationLink') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('#vat-registration');
  });

  it('enables the toggle when verified', () => {
    render(
      <TaxGeneralSettings
        {...base}
        vatVerified
        settings={{ taxEnabled: false, taxIncludedInPrice: false }}
      />
    );
    const [enable] = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(enable.disabled).toBe(false);
    expect(screen.queryByText('enable.needsVerificationLink')).toBeNull();
  });

  it('shows a server refusal message', () => {
    render(
      <TaxGeneralSettings
        {...base}
        vatVerified={false}
        errorMessage="not verified"
        settings={{ taxEnabled: false, taxIncludedInPrice: false }}
      />
    );
    expect(screen.getByRole('alert').textContent).toBe('not verified');
  });
});
