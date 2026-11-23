// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PROVIDER_CATALOG } from '@ebda/shared';
import { ProviderLogo } from './ProviderLogo';

describe('ProviderLogo', () => {
  it('renders an img with the provider name as alt for a vendored asset', () => {
    render(<ProviderLogo code="paymob" name="Paymob" />);
    expect(screen.getByAltText('Paymob')).toBeTruthy();
  });
  it('renders a labelled wordmark when there is no asset', () => {
    render(<ProviderLogo code="geidea" name="Geidea" />);
    expect(screen.getByRole('img', { name: 'Geidea' })).toBeTruthy();
  });
  it('renders something accessible for every catalog provider', () => {
    for (const p of PROVIDER_CATALOG) {
      const { unmount } = render(<ProviderLogo code={p.code} name={p.name.en} />);
      expect(screen.getByTestId(`provider-logo-${p.code}`)).toBeTruthy();
      unmount();
    }
  });
});
