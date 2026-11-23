// @vitest-environment jsdom
/**
 * "Add a page" must never call window.prompt: a native prompt blocks the tab
 * (and every automation driver) until answered, which QA read as a 30-45 s
 * freeze (Amelia 2026-11-23). It opens an in-app dialog and routes on a valid slug.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('next-intl', () => {
  const t = Object.assign((key: string) => key, { has: () => true });
  return { useTranslations: () => t, useLocale: () => 'en' };
});
const push = vi.fn();
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 's1' }),
  useRouter: () => ({ push }),
}));
vi.mock('next/link', () => ({
  default: (p: { children: React.ReactNode }) => <a>{p.children}</a>,
}));
vi.mock('@ebda/ui', () => ({
  useToast: () => ({ error: vi.fn(), success: vi.fn() }),
  Modal: ({ isOpen, children }: { isOpen: boolean; children: React.ReactNode }) =>
    isOpen ? <div role="dialog">{children}</div> : null,
}));
vi.mock('../../../../components/AdminLayout', () => ({
  AdminLayout: ({ actions, children }: { actions: React.ReactNode; children: React.ReactNode }) => (
    <div>
      {actions}
      {children}
    </div>
  ),
}));
vi.mock('@/hooks/useConfirm', () => ({ useConfirm: () => async () => true }));
vi.mock('../../../../lib/api', () => ({
  apiDelete: vi.fn().mockResolvedValue({ error: null }),
  apiGet: vi.fn().mockResolvedValue({ data: { pages: [] }, error: null }),
}));

import ContentListPage from './page';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  push.mockReset();
});

describe('content list: add page', () => {
  it('opens an in-app dialog and never calls window.prompt', async () => {
    const prompt = vi.spyOn(window, 'prompt').mockImplementation(() => {
      throw new Error('window.prompt blocks the tab');
    });
    render(<ContentListPage />);
    fireEvent.click(screen.getByText('newPage'));
    expect(prompt).not.toHaveBeenCalled();
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  it('is name-first: an Arabic title makes an Arabic slug and travels to the editor', async () => {
    render(<ContentListPage />);
    fireEvent.click(screen.getByText('newPage'));
    const input = (await screen.findByRole('dialog')).querySelector('input')!;
    fireEvent.change(input, { target: { value: 'صفحة اختبار' } });
    fireEvent.click(screen.getByText('newPageConfirm'));
    expect(push).toHaveBeenCalledWith(
      `/stores/s1/content/${encodeURIComponent('صفحة-اختبار')}?title=${encodeURIComponent('صفحة اختبار')}`
    );
  });

  it('an English title is slugged and an empty title is refused inline', async () => {
    render(<ContentListPage />);
    fireEvent.click(screen.getByText('newPage'));
    const input = (await screen.findByRole('dialog')).querySelector('input')!;
    fireEvent.click(screen.getByText('newPageConfirm'));
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(push).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: 'Our Story' } });
    fireEvent.click(screen.getByText('newPageConfirm'));
    expect(push).toHaveBeenCalledWith(
      `/stores/s1/content/our-story?title=${encodeURIComponent('Our Story')}`
    );
  });
});
