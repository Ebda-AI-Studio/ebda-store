// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

vi.mock('next-intl', () => {
  const t = Object.assign(
    (key: string, p?: Record<string, unknown>) => (p ? `${key}:${JSON.stringify(p)}` : key),
    {
      has: () => true,
    }
  );
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
          publishedAt: '2026-10-26T10:05:00Z',
          publishedByName: 'منى عادل',
          publishedBy: 'u1',
        },
        {
          rev: 4,
          status: 'archived',
          note: 'rollback to rev 2',
          createdAt: '2026-10-25T10:00:00Z',
          publishedAt: '2026-10-25T10:05:00Z',
          publishedByName: null,
          publishedBy: 'u2',
        },
        {
          rev: 1,
          status: 'archived',
          note: null,
          createdAt: '2026-10-01T10:00:00Z',
          publishedAt: null,
          publishedByName: null,
          publishedBy: null,
        },
      ],
    },
  })),
  apiPost: vi.fn(),
}));

import { RevisionsPanel } from './RevisionsPanel';

afterEach(cleanup);

describe('RevisionsPanel shows who and when', () => {
  it('names the publisher, falls back for an unnamed or legacy one, and keeps one-click restore', async () => {
    render(<RevisionsPanel storeId="s" headRev={5} onRestored={() => {}} />);
    await waitFor(() => expect(screen.getAllByRole('listitem').length).toBe(3));
    expect(screen.getByText(/by\.named.*منى عادل/)).toBeTruthy();
    expect(screen.getAllByText(/by\.unknown/).length).toBe(1); // rev 4: id but no name
    // rev 1 predates the column: no "by" line at all
    const items = screen.getAllByRole('listitem');
    expect(items[2].textContent).not.toContain('by.');
    expect(screen.getAllByText('restore').length).toBe(2);
  });
});
