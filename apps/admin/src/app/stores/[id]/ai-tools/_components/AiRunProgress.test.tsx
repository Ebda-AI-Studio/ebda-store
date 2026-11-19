// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { ActiveJobCard, MasterSweepCard, type RunJob } from './AiRunProgress';

type TFn = ComponentProps<typeof ActiveJobCard>['t'];

afterEach(cleanup);

const t = ((key: string, vals?: Record<string, unknown>) =>
  vals ? `${key}:${JSON.stringify(vals)}` : key) as unknown as TFn;

const job = (over: Partial<RunJob> = {}): RunJob => ({
  id: 'j1',
  kind: 'seo',
  status: 'running',
  direction: null,
  total: 40,
  processed: 10,
  filled: 8,
  skipped: 2,
  failed: 0,
  errorMessage: null,
  startedAt: '2026-11-15T10:00:00Z',
  completedAt: null,
  ...over,
});

describe('ActiveJobCard', () => {
  it('running: live progress bar, "you can leave" line, Stop button', () => {
    render(<ActiveJobCard job={job()} storeId="s1" onCancel={vi.fn()} onClose={vi.fn()} t={t} />);
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('25');
    expect(screen.getByText('progress.running')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'activeJob.cancel' })).toBeTruthy();
  });

  it('completed: plain-language summary, results link, no Stop button', () => {
    render(
      <ActiveJobCard
        job={job({ status: 'completed', processed: 40, completedAt: '2026-11-15T10:05:00Z' })}
        storeId="s1"
        onClose={vi.fn()}
        t={t}
      />
    );
    expect(screen.getByText(/progress.doneSummary/).textContent).toContain('"filled"');
    expect(screen.getByRole('link', { name: 'progress.seeResults' }).getAttribute('href')).toBe(
      '#ai-results'
    );
    expect(screen.queryByRole('button', { name: 'activeJob.cancel' })).toBeNull();
    expect(screen.queryByText('progress.undoHint')).toBeNull();
  });

  it('a finished language fix points at the undo tool', () => {
    render(
      <ActiveJobCard
        job={job({ kind: 'description_balance', status: 'completed', processed: 40 })}
        storeId="s1"
        onClose={vi.fn()}
        t={t}
      />
    );
    expect(screen.getByRole('link', { name: 'progress.undoHint' }).getAttribute('href')).toBe(
      '#tool-revert-balance'
    );
  });

  it('failed: shows the failure sentence and the server message as an alert', () => {
    render(
      <ActiveJobCard
        job={job({ status: 'failed', errorMessage: 'Daily AI request cap reached' })}
        storeId="s1"
        onClose={vi.fn()}
        t={t}
      />
    );
    expect(screen.getByText('progress.failedSummary')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe('Daily AI request cap reached');
  });

  it('lists the products it changed and the items that failed behind disclosures', () => {
    render(
      <ActiveJobCard
        job={job({
          status: 'completed',
          filledProducts: [{ id: 'p1', name: 'Mug' }],
          errors: [{ entityKind: 'product', entityId: 'p2', entityName: 'Cup', error: 'boom' }],
        })}
        storeId="s1"
        onClose={vi.fn()}
        t={t}
      />
    );
    expect(screen.getByRole('link', { name: 'Mug' }).getAttribute('href')).toBe(
      '/stores/s1/products/p1'
    );
    expect(screen.getByText(/Cup/)).toBeTruthy();
  });
});

describe('MasterSweepCard', () => {
  it('sums the child jobs and lists each one with its status', () => {
    render(
      <MasterSweepCard
        label="Run all answer tools"
        jobs={[
          job({ id: 'a', kind: 'faq_aeo', processed: 5, total: 10, filled: 5 }),
          job({ id: 'b', kind: 'howto_aeo', status: 'queued', processed: 0, total: 10, filled: 0 }),
        ]}
        onCancel={vi.fn()}
        onClose={vi.fn()}
        t={t}
      />
    );
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('25');
    expect(screen.getByText('jobKind.faqAeo')).toBeTruthy();
    expect(screen.getByText('jobKind.howtoAeo')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'activeJob.cancelAll' })).toBeTruthy();
  });
});
