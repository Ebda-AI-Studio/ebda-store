// @vitest-environment jsdom
/** QA 2026-11-23: the "search result preview" showed the literal example.com for a store with a custom domain. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock('../../../../lib/api', () => ({
  apiGet,
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  unwrapObject: (x: unknown) => x,
}));
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'store-1' }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('../../../../components/AdminLayout', () => ({
  AdminLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('../../../../components/ImageUpload', () => ({ ImageUpload: () => null }));
vi.mock('../../../../components/StickySaveBar', () => ({ StickySaveBar: () => null }));
vi.mock('@ebda/ui', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
vi.mock('@/i18n/useT', () => ({ useT: () => (key: string) => key }));

import StoreSeoPage from './page';

function load(store: Record<string, unknown>) {
  apiGet.mockImplementation(async (url: string) =>
    url.endsWith('/seo')
      ? { data: { seo: { metaTitle: 'Amelia Aurum', metaTitleAr: 'أميليا' } } }
      : { data: { store: { settings: { defaultLanguage: 'en' }, ...store } } }
  );
}
afterEach(() => cleanup());

describe('SEO search preview host', () => {
  it('uses the verified custom domain', async () => {
    load({ slug: 'amelia', domain: 'ameliaaurum.com', domainVerifiedAt: '2026-11-01T00:00:00Z' });
    render(<StoreSeoPage />);
    expect(await screen.findByText('ameliaaurum.com')).toBeTruthy();
    expect(screen.queryByText('previewDomain')).toBeNull();
  });
  it('falls back to <slug>.ebda.app, never example.com', async () => {
    load({ slug: 'amelia' });
    render(<StoreSeoPage />);
    expect(await screen.findByText('amelia.ebda.app')).toBeTruthy();
  });
});
