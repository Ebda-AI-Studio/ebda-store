// @vitest-environment jsdom
/** 404-1 (orders PWA): a calm line, a search entry that opens the list focused, quick links, a way back. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MESSAGES } from '@/i18n/messages';
import NotFound from './not-found';

let locale: 'en' | 'ar' = 'ar';
vi.mock('next/link', () => ({
  default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...r}>
      {children}
    </a>
  ),
}));
vi.mock('@/contexts/LanguageContext', () => ({
  useLanguage: () => ({ t: MESSAGES[locale] }),
}));

afterEach(cleanup);

describe('orders PWA 404', () => {
  it('Egyptian Arabic by default, with the search entry and quick links; the term never rides in a URL', () => {
    render(<NotFound />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'الصفحة اللي بتدوّر عليها مش موجودة.'
    );
    const hrefs = screen.getAllByRole('link').map(a => a.getAttribute('href'));
    expect(hrefs).toEqual(['/orders?focus=search', '/', '/orders', 'https://ebda.app']);
    expect(hrefs.join()).not.toMatch(/[?&]q=/);
  });

  it('English, and no orange', () => {
    locale = 'en';
    const { container } = render(<NotFound />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      "The page you're looking for can't be found."
    );
    expect(container.innerHTML.toLowerCase()).not.toMatch(/orange|#ff6e01/);
  });
});
