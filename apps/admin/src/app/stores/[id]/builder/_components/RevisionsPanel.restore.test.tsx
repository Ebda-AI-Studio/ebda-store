// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const apiPost = vi.fn();
vi.mock('next-intl', () => {
  const t = Object.assign((key: string) => key, { has: () => true });
  return {
    useTranslations: () => t,
    useLocale: () => 'ar',
    useFormatter: () => ({ dateTime: () => 'WHEN' }),
  };
});
vi.mock('../../../../../lib/api', () => ({
  apiGet: vi.fn(async () => ({
    data: {
      nextCursor: null,
      revisions: [
        {
          rev: 5,
          status: 'published',
          note: null,
          createdAt: '2026-10-26T10:00:00Z',
          publishedAt: null,
          publishedByName: null,
          publishedBy: null,
        },
        {
          rev: 4,
          status: 'archived',
          note: null,
          createdAt: '2026-10-25T10:00:00Z',
          publishedAt: null,
          publishedByName: null,
          publishedBy: null,
        },
      ],
    },
  })),
  apiPost: (...a: unknown[]) => apiPost(...a),
}));
import { RevisionsPanel } from './RevisionsPanel';

// jsdom has no <dialog>.showModal
HTMLDialogElement.prototype.showModal = function showModal() {
  this.setAttribute('open', '');
};

afterEach(() => {
  cleanup();
  apiPost.mockReset();
});

describe('STORE-QA-68 restore a version', () => {
  it('restore -> confirm -> rollback to THAT rev against the current head, then tells the editor', async () => {
    apiPost.mockResolvedValue({ data: { rev: 6 }, error: null });
    const onRestored = vi.fn();
    render(<RevisionsPanel storeId="s1" headRev={5} onRestored={onRestored} />);
    fireEvent.click(await screen.findByText('restore'));
    fireEvent.click(await screen.findByText('restoreConfirmButton'));
    await waitFor(() => expect(onRestored).toHaveBeenCalledTimes(1));
    expect(apiPost).toHaveBeenCalledWith('/api/v1/admin/stores/s1/builder/pages/home/rollback', {
      targetRev: 4,
      baseRev: 5,
    });
  });
  it('a refused restore says so instead of staying silent', async () => {
    apiPost.mockResolvedValue({ data: null, error: { message: 'x' } });
    const onRestored = vi.fn();
    render(<RevisionsPanel storeId="s1" headRev={5} onRestored={onRestored} />);
    fireEvent.click(await screen.findByText('restore'));
    fireEvent.click(await screen.findByText('restoreConfirmButton'));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(onRestored).not.toHaveBeenCalled();
  });
});
