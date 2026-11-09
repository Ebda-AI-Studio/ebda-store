// @vitest-environment jsdom
// QA P2-8 / D4: the shopper can ask for the verification link again from check-email and from login.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('../lib/api', () => ({ api: { post: h.post } }));
vi.mock('../contexts/StoreContext', () => ({ useStore: () => ({ store: { id: 'store-1' } }) }));
vi.mock('../contexts/LanguageContext', () => ({
  useLanguage: () => ({ t: (_en: string, ar: string) => ar }),
}));

import ResendVerification from './ResendVerification';

afterEach(() => {
  cleanup();
  h.post.mockReset();
});

describe('ResendVerification', () => {
  it('posts email + storeId to /auth/resend-verification and confirms in Arabic', async () => {
    h.post.mockResolvedValue({ success: true, data: {} });
    render(<ResendVerification email="a@b.co" />);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() =>
      expect(h.post).toHaveBeenCalledWith('/auth/resend-verification', {
        email: 'a@b.co',
        storeId: 'store-1',
      })
    );
    expect(await screen.findByRole('status')).toBeTruthy();
  });

  it('asks for the email when none is known, and does not post without one', async () => {
    render(<ResendVerification email="" />);
    fireEvent.click(screen.getByRole('button'));
    expect(h.post).not.toHaveBeenCalled();
    expect(container()).toBeTruthy();
  });

  it('shows an error when the request fails', async () => {
    h.post.mockResolvedValue({ success: false, error: { code: 'RATE_LIMITED', message: 'x' } });
    render(<ResendVerification email="a@b.co" />);
    fireEvent.click(screen.getByRole('button'));
    expect(await screen.findByRole('alert')).toBeTruthy();
  });
});

function container() {
  return document.querySelector('input[type="email"]');
}
