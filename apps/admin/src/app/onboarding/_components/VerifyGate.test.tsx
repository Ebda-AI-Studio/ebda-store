// @vitest-environment jsdom
/** UX:S-5 - a throttled resend names the rate limit instead of the generic send failure. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const { apiPost } = vi.hoisted(() => ({ apiPost: vi.fn() }));
vi.mock('../../../lib/api', () => ({ apiPost }));
vi.mock('@/i18n/useT', () => ({
  useT: (ns?: string) => (key: string) => `${ns ? `${ns}.` : ''}${key}`,
}));

import { VerifyGate } from './VerifyGate';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('VerifyGate resend', () => {
  it('429 shows the rate-limit text', async () => {
    apiPost.mockResolvedValue({ error: { code: 'RATE_LIMITED', status: 429, message: 'x' } });
    render(<VerifyGate email="a@b.test" onRefresh={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.flow.verifyGate.resend' }));
    expect(await screen.findByText('onboarding.flow.verifyGate.rateLimited')).toBeTruthy();
    expect(screen.queryByText('onboarding.flow.verifyGate.sendFailed')).toBeNull();
  });

  it('any other failure keeps the generic text', async () => {
    apiPost.mockResolvedValue({ error: { code: 'SERVER_ERROR', status: 500, message: 'x' } });
    render(<VerifyGate email="a@b.test" onRefresh={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'onboarding.flow.verifyGate.resend' }));
    expect(await screen.findByText('onboarding.flow.verifyGate.sendFailed')).toBeTruthy();
  });
});
