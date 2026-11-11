// @vitest-environment jsdom
/** GoldRateBanner: a rate waiting for the owner is shown even with zero gold products (it was hidden). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';

const apiGet = vi.fn();
vi.mock('../../apps/admin/src/lib/api', () => ({ apiGet: (...a: unknown[]) => apiGet(...a) }));
vi.mock('../../apps/admin/src/i18n/useT', () => ({ useT: () => (k: string) => k }));
vi.mock('next/link', () => ({
  default: (p: { children: React.ReactNode }) => <a>{p.children}</a>,
}));

import { GoldRateBanner } from '../../apps/admin/src/app/stores/[id]/_components/GoldRateBanner';

afterEach(cleanup);
const state = (over: object) => ({
  data: { settings: { enabled: true }, goldProductCount: 0, rates: [], pending: [], ...over },
});

describe('GoldRateBanner', () => {
  it('pending rate + disagreement + 0 gold products: the decision line shows', async () => {
    apiGet.mockResolvedValue(state({ pending: [{ id: 'r' }], disagreement: { diffBps: 281 } }));
    render(<GoldRateBanner storeId="s" />);
    expect((await screen.findByRole('alert')).textContent).toContain('disagree');
  });
  it('nothing pending and no gold products: renders nothing', async () => {
    apiGet.mockResolvedValue(state({}));
    const { container } = render(<GoldRateBanner storeId="s" />);
    await new Promise(r => setTimeout(r, 20));
    expect(container.innerHTML).toBe('');
  });
});
