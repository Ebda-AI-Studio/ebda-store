// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PROVIDER_CATALOG, SOCIAL_LOGO_CODES } from '@ebda/shared';
import { ProviderLogo } from './ProviderLogo';

describe('ProviderLogo', () => {
  it('renders an img with the provider name as alt for a vendored asset', () => {
    render(<ProviderLogo code="paymob" name="Paymob" />);
    expect(screen.getByAltText('Paymob')).toBeTruthy();
  });
  it('renders a labelled wordmark when there is no asset', () => {
    render(<ProviderLogo code="snapchat" name="Snapchat" />);
    expect(screen.getByRole('img', { name: 'Snapchat' })).toBeTruthy();
  });
  it('renders something accessible for every catalog provider', () => {
    for (const p of PROVIDER_CATALOG) {
      const { unmount } = render(<ProviderLogo code={p.code} name={p.name.en} />);
      expect(screen.getByTestId(`provider-logo-${p.code}`)).toBeTruthy();
      unmount();
    }
  });

  it('renders the official logo for geidea and every social platform except snapchat', () => {
    for (const code of ['geidea', ...SOCIAL_LOGO_CODES.filter(c => c !== 'snapchat')]) {
      const { unmount } = render(<ProviderLogo code={code} name={code} size="sm" />);
      expect(screen.getByAltText(code)).toBeTruthy();
      unmount();
    }
  });

  it('renders a labelled wordmark for snapchat and an unknown key', () => {
    for (const code of ['snapchat', 'wikidata']) {
      const { unmount } = render(<ProviderLogo code={code} name={code} size="sm" />);
      expect(screen.getByRole('img', { name: code })).toBeTruthy();
      unmount();
    }
  });
});
