// @vitest-environment jsdom
/**
 * History timeline (findings 37/38): relative day ("Today 3:40 pm"), who, a one-line summary from the
 * row's own data, Restore behind the existing confirm, and `text-primary-ink` for the live status.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('next-intl', () => {
  const t = Object.assign(
    (key: string, p?: Record<string, unknown>) => (p ? `${key}:${JSON.stringify(p)}` : key),
    { has: () => true }
  );
  return { useTranslations: () => t, useLocale: () => 'en' };
});

const NOW = new Date('2026-11-17T15:40:00');
const iso = (d: Date) => d.toISOString();
const today = new Date('2026-11-17T09:05:00');
const yesterday = new Date('2026-11-16T21:10:00');
const older = new Date('2026-10-01T10:00:00');

vi.mock('../../../../../lib/api', () => ({
  apiGet: vi.fn(async () => ({
    data: {
      nextCursor: null,
      revisions: [
        {
          rev: 7,
          status: 'published',
          note: null,
          createdAt: iso(today),
          publishedAt: iso(today),
          publishedBy: 'u1',
          publishedByName: 'Mona',
        },
        {
          rev: 6,
          status: 'archived',
          note: 'rollback to rev 2',
          createdAt: iso(yesterday),
          publishedAt: iso(yesterday),
          publishedBy: 'u1',
          publishedByName: 'Mona',
        },
        {
          rev: 2,
          status: 'archived',
          note: null,
          createdAt: iso(older),
          publishedAt: null,
          publishedBy: null,
          publishedByName: null,
        },
      ],
    },
  })),
  apiPost: vi.fn(async () => ({ data: {} })),
}));

import { RevisionsPanel } from './RevisionsPanel';

beforeEach(() => {
  // jsdom has no <dialog>.showModal (the confirm uses it)
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

const mount = () => render(<RevisionsPanel storeId="s1" headRev={7} onRestored={() => {}} />);

describe('RevisionsPanel timeline', () => {
  it('37: today and yesterday read as a relative day + time, older rows as a date', async () => {
    mount();
    await waitFor(() => expect(screen.getAllByRole('listitem').length).toBe(3));
    const items = screen.getAllByRole('listitem');
    expect(items[0].textContent).toMatch(/today .*(AM|PM|am|pm)/);
    expect(items[1].textContent).toContain('yesterday ');
    expect(items[2].textContent).toMatch(/Oct 1, 2026/);
  });

  it('37: who + a one-line summary computed from the row (restore note, live, draft)', async () => {
    mount();
    await waitFor(() => expect(screen.getAllByRole('listitem').length).toBe(3));
    expect(screen.getAllByText(/by\.named.*Mona/)).toHaveLength(2);
    expect(screen.getByTestId('rev-summary-7').textContent).toBe('summary.published');
    expect(screen.getByTestId('rev-summary-6').textContent).toContain('restoredFrom');
    expect(screen.getByTestId('rev-summary-2').textContent).toBe('summary.draft');
  });

  it('37: Restore still asks first (the existing confirm)', async () => {
    mount();
    await waitFor(() => expect(screen.getAllByText('restore').length).toBe(2));
    fireEvent.click(screen.getAllByText('restore')[0]);
    expect(screen.getByText('confirmRestoreTitle')).toBeTruthy();
  });

  it('38: the live status uses text-primary-ink, never bare text-primary', async () => {
    mount();
    await waitFor(() => expect(screen.getAllByRole('listitem').length).toBe(3));
    const live = screen.getByText('status.published');
    expect(live.className).toContain('text-primary-ink');
    expect(live.className).not.toMatch(/text-primary(?!-)/);
  });
});
