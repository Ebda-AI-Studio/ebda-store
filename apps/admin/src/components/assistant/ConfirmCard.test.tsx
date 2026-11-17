// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';

vi.mock('next-intl', () => {
  const t = Object.assign(
    (key: string, v?: Record<string, unknown>) => (v ? `${key}:${JSON.stringify(v)}` : key),
    { has: () => true }
  );
  return { useTranslations: () => t, useLocale: () => 'ar' };
});

import { ConfirmCard } from './ConfirmCard';
import type { ConfirmData, PreviewCardData, UndoData } from '../../lib/assistant';

afterEach(cleanup);

const card = (over: Partial<PreviewCardData> = {}): PreviewCardData => ({
  previewId: 'p1',
  approvalId: 'ap1',
  summary: { ar: 'هخصم 10٪ على 30 عباية.', en: 'I will take 10% off 30 abayas.' },
  rows: [{ label: { ar: 'السعر', en: 'Price' }, before: 500, after: 450 }],
  policy: 'confirm',
  reasons: ['bulk', 'price'],
  undo: 'reversible',
  ...over,
});
type Ok<T> = Promise<{ data?: T; error?: { code: string } }>;
const mount = (o: {
  card?: PreviewCardData;
  token?: string | undefined;
  confirm?: (id: string, token: string) => Ok<ConfirmData>;
  reject?: (id: string) => Promise<{ error?: { code: string } }>;
  undo?: (id: string) => Ok<UndoData>;
  onFresh?: (id: string, t: string) => void;
}) =>
  render(
    <ConfirmCard
      card={o.card ?? card()}
      token={'token' in o ? o.token : 'tok-tok-tok-tok-tok-tok'}
      onConfirm={
        o.confirm ??
        (async () => ({
          data: { status: 'applied', appliedId: 'a1', undoUntil: Date.now() + 24 * 3_600_000 },
        }))
      }
      onReject={o.reject ?? (async () => ({}))}
      onUndo={o.undo ?? (async () => ({ data: { status: 'undone' } }))}
      onFresh={o.onFresh}
    />
  );

describe('ConfirmCard', () => {
  it('shows the rows, the reason chips and a gold "yes" and a "no"', () => {
    mount({});
    expect(screen.getByText('confirm.reasons.bulk')).toBeTruthy();
    expect(screen.getByText('confirm.reasons.price')).toBeTruthy();
    expect(screen.getByText('450')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'confirm.yes' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'confirm.no' })).toBeTruthy();
  });

  it('the yes button sends the approval id and the one-time token, once', async () => {
    const confirm = vi.fn(async () => ({
      data: {
        status: 'applied',
        appliedId: 'a1',
        undoUntil: Date.now() + 23 * 3_600_000,
      } as ConfirmData,
    }));
    mount({ confirm });
    fireEvent.click(screen.getByRole('button', { name: 'confirm.yes' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /card\.undo/ })).toBeTruthy());
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith('ap1', 'tok-tok-tok-tok-tok-tok');
  });

  it('a refund (irreversible) says it cannot be undone before and after, and offers no Undo', async () => {
    mount({ card: card({ undo: 'irreversible', reasons: ['money', 'irreversible'] }) });
    expect(screen.getByText('confirm.irreversible')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'confirm.yes' }));
    await waitFor(() => expect(screen.getByText('confirm.appliedFinal')).toBeTruthy());
    expect(screen.queryByRole('button', { name: /card\.undo/ })).toBeNull();
  });

  it('shows the credit cost when there is one', () => {
    mount({ card: card({ costCredits: 12 }) });
    expect(screen.getByText(/confirm\.cost/).textContent).toContain('12');
  });

  it('"no" rejects through the route and nothing else', async () => {
    const reject = vi.fn(async () => ({}));
    const confirm = vi.fn();
    mount({ reject, confirm });
    fireEvent.click(screen.getByRole('button', { name: 'confirm.no' }));
    await waitFor(() => expect(screen.getByText('confirm.rejected')).toBeTruthy());
    expect(reject).toHaveBeenCalledWith('ap1');
    expect(confirm).not.toHaveBeenCalled();
  });

  it('without a token (after a reload) there is no yes button, only the ask-again note', () => {
    mount({ token: undefined });
    expect(screen.queryByRole('button', { name: 'confirm.yes' })).toBeNull();
    expect(screen.getByText('confirm.noToken')).toBeTruthy();
  });

  it('stale: replaced by the fresh card, its new token is handed up, and the new yes uses it', async () => {
    const onFresh = vi.fn();
    const confirm = vi
      .fn<(id: string, token: string) => Ok<ConfirmData>>()
      .mockResolvedValueOnce({
        data: {
          status: 'stale',
          card: card({
            approvalId: 'ap2',
            rows: [{ label: { ar: 'السعر', en: 'Price' }, before: 480, after: 432 }],
          }),
          approvals: [{ approvalId: 'ap2', token: 'new-new-new-new-new-new' }],
        },
      })
      .mockResolvedValueOnce({
        data: { status: 'applied', appliedId: 'a9', undoUntil: Date.now() + 3_600_000 },
      });
    mount({ confirm, onFresh });
    fireEvent.click(screen.getByRole('button', { name: 'confirm.yes' }));
    await waitFor(() => expect(screen.getByText('432')).toBeTruthy());
    expect(onFresh).toHaveBeenCalledWith('ap2', 'new-new-new-new-new-new');
    expect(screen.getByText('card.stale')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'confirm.yes' }));
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(2));
    expect(confirm.mock.calls[1]).toEqual(['ap2', 'new-new-new-new-new-new']);
  });

  it('a refusal shows its reason and says nothing was applied', async () => {
    mount({ confirm: async () => ({ error: { code: 'FORBIDDEN' } }) });
    fireEvent.click(screen.getByRole('button', { name: 'confirm.yes' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe('confirm.failed.forbidden')
    );
    expect(screen.queryByText('card.applied')).toBeNull();
  });

  it('an already used approval is reported as used', async () => {
    mount({ confirm: async () => ({ error: { code: 'APPROVAL_USED' } }) });
    fireEvent.click(screen.getByRole('button', { name: 'confirm.yes' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('confirm.failed.used'));
  });

  it('row text is never markup', () => {
    const { container } = mount({
      card: card({
        rows: [{ label: { ar: 'x', en: 'x' }, after: '<img src=x onerror=alert(1)>' }],
      }),
    });
    expect(container.querySelector('img')).toBeNull();
  });

  it('has no axe violations', async () => {
    const { container } = mount({});
    expect((await axe.run(container)).violations).toEqual([]);
  });
});
