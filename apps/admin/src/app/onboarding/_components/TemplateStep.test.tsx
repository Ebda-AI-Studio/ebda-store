// @vitest-environment jsdom
/**
 * Bug 8 (editor P1s, plan-from-2026-10-14.md §3): the onboarding template
 * step offered only the 5 legacy templates — Dahab (TemplateId `dahab`,
 * Ruling DAHAB-1) was missing even though the post-creation template-switch
 * page (`apps/admin/src/app/stores/[id]/template/page.tsx`) and
 * `PUT /stores/:id/template` have accepted it since Ruling DAHAB-3. Ahmad's
 * 2026-10-10 plan instruction supersedes DAHAB-3's "not offered in
 * onboarding yet" clause: "Dahab template missing from onboarding. Offer
 * it." This test proves a merchant can now pick Dahab at onboarding time,
 * same as any other template.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { apiPut } = vi.hoisted(() => ({ apiPut: vi.fn() }));
vi.mock('../../../lib/api', () => ({ apiPut }));
vi.mock('next-intl', () => ({ useLocale: () => 'en' }));
vi.mock('@/i18n/useT', () => {
  const useT = (ns?: string) => (key: string, vars?: Record<string, unknown>) =>
    `${ns ? `${ns}.` : ''}${key}${vars ? `:${JSON.stringify(vars)}` : ''}`;
  return { useT };
});

import { TemplateStep } from './TemplateStep';
import { TEMPLATE_IDS } from './types';

beforeEach(() => {
  apiPut.mockResolvedValue({ data: {}, error: null });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('TemplateStep — Dahab offered at onboarding', () => {
  it('includes dahab in the supported template list', () => {
    expect(TEMPLATE_IDS).toContain('dahab');
  });

  it('renders Dahab as a pickable radio option alongside the 5 legacy templates', () => {
    render(<TemplateStep storeId="s1" initial="modern" onBack={vi.fn()} onDone={vi.fn()} />);
    const options = screen.getAllByRole('radio');
    expect(options).toHaveLength(6);
    expect(screen.getByRole('radio', { name: /^onboarding\.flow\.template\.dahab/ })).toBeTruthy();
  });

  it('saves template: dahab when the merchant picks it and continues', async () => {
    const onDone = vi.fn();
    render(<TemplateStep storeId="s1" initial="modern" onBack={vi.fn()} onDone={onDone} />);
    fireEvent.click(screen.getByRole('radio', { name: /^onboarding\.flow\.template\.dahab/ }));
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.flow.next' }));
    await waitFor(() =>
      expect(apiPut).toHaveBeenCalledWith('/api/v1/stores/s1/template', { template: 'dahab' })
    );
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('dahab'));
  });
});
