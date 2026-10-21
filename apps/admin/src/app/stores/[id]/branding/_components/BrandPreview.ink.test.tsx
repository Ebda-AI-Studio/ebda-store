// @vitest-environment jsdom
/**
 * Review N2 (K-02): the Branding preview's primary button takes the readable ink the storefront
 * derives for the merchant's colour (`pickReadableForeground`), never a hard-coded white —
 * white on a mid-tone (the Ebda gold, an orange) fails AA.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('@/i18n/useT', () => ({
  useT: (ns?: string) => (key: string) => `${ns ? `${ns}.` : ''}${key}`,
}));

import { BrandPreview } from './BrandPreview';

afterEach(cleanup);

const button = () => screen.getByRole('button', { name: 'branding.preview.primaryButton' });

describe('BrandPreview primary button ink', () => {
  it.each([
    ['Ebda gold', '36 36% 52%', 'rgb(0, 0, 0)'],
    ['a merchant orange', '26 100% 50%', 'rgb(0, 0, 0)'],
    ['Ebda night', '210 9% 4%', 'rgb(255, 255, 255)'],
  ])('%s gets the readable ink', (_n, primaryColor, ink) => {
    render(<BrandPreview theme={{ primaryColor } as never} />);
    expect(button().style.color).toBe(ink);
    expect(button().className).not.toMatch(/\btext-white\b/);
  });
});
