// @vitest-environment jsdom
/** Custom pages had no delete control (Amelia 2026-11-23). Custom pages get one (in-app confirm, never window.confirm); standard pages do not. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('next-intl', () => {
  const t = Object.assign((key: string) => key, { has: () => true });
  return { useTranslations: () => t, useLocale: () => 'en' };
});
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 's1' }),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: (p: { children: React.ReactNode }) => <a>{p.children}</a>,
}));
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() })); // stable: the page refetches when it changes
vi.mock('@ebda/ui', () => ({
  useToast: () => toast,
  Modal: () => null,
}));
vi.mock('../../../../components/AdminLayout', () => ({
  AdminLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
const { apiGet, apiDelete, confirm } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiDelete: vi.fn(),
  confirm: vi.fn(),
}));
vi.mock('@/hooks/useConfirm', () => ({ useConfirm: () => confirm }));
vi.mock('../../../../lib/api', () => ({ apiGet, apiDelete }));
const pagesResponse = (pages: unknown[]) => (url: string) =>
  Promise.resolve(
    url.endsWith('/pages')
      ? { data: { pages }, error: null }
      : { data: { store: { slug: 'amelia', domain: 'ameliaaurum.com' } }, error: null }
  );

import ContentListPage from './page';

const row = (slug: string) => ({
  id: slug,
  storeId: 's1',
  slug,
  title: slug,
  isPublished: true,
  position: 0,
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('content list: view page', () => {
  it('a published custom page links to its public URL on the store domain; a draft does not', async () => {
    apiGet.mockImplementation(
      pagesResponse([row('qa-test-page'), { ...row('صفحة-اختبار'), isPublished: false }])
    );
    render(<ContentListPage />);
    const link = (await screen.findByText('viewPage')).closest('a')!;
    expect(link.getAttribute('href')).toBe('https://ameliaaurum.com/pages/qa-test-page');
    expect(screen.getAllByText('viewPage')).toHaveLength(1);
  });
});

describe('content list: delete', () => {
  it('only custom pages show Delete; it confirms in-app, then calls the tenant-scoped DELETE', async () => {
    apiGet.mockImplementation(pagesResponse([row('about'), row('qa-test-page')]));
    apiDelete.mockResolvedValue({ error: null });
    confirm.mockResolvedValue(true);
    const nativeConfirm = vi.spyOn(window, 'confirm').mockImplementation(() => {
      throw new Error('no native confirm');
    });
    render(<ContentListPage />);
    const buttons = await screen.findAllByText('deletePage');
    expect(buttons).toHaveLength(1); // about is standard: no control
    fireEvent.click(buttons[0]);
    await waitFor(() =>
      expect(apiDelete).toHaveBeenCalledWith('/api/v1/stores/s1/pages/qa-test-page')
    );
    expect(nativeConfirm).not.toHaveBeenCalled();
    expect(confirm).toHaveBeenCalledOnce();
  });

  it('cancelling the confirm deletes nothing', async () => {
    apiGet.mockImplementation(pagesResponse([row('qa-test-page')]));
    confirm.mockResolvedValue(false);
    render(<ContentListPage />);
    fireEvent.click(await screen.findByText('deletePage'));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(apiDelete).not.toHaveBeenCalled();
  });
});
