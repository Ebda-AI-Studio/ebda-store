/** STORE-QA-56: a cookie-only multipart POST from the admin origin passes only with the custom header. */
import { describe, it, expect, vi } from 'vitest';
import { csrfProtection } from '../security';
import { config } from '../../config';

function run(headers: Record<string, string>) {
  const req = {
    method: 'POST',
    path: '/api/v1/stores/s1/billing/receipts',
    headers,
    cookies: { token: 'jwt' },
  } as never;
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as never;
  const next = vi.fn();
  csrfProtection(req, res, next);
  return { res: res as { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> }, next };
}

describe('csrfProtection multipart from the admin origin', () => {
  const origin = config.adminUrl || 'https://store.ebda.app';
  const base = { origin, 'content-type': 'multipart/form-data; boundary=x' };

  it('403s CSRF_MISSING_SESSION without X-Requested-With (the bug)', () => {
    const { res, next } = run(base);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json.mock.calls[0][0].error.code).toBe('CSRF_MISSING_SESSION');
  });

  it('passes with X-Requested-With (what the admin apiFetch now sends)', () => {
    const { next } = run({ ...base, 'x-requested-with': 'XMLHttpRequest' });
    expect(next).toHaveBeenCalled();
  });

  it('still refuses a merchant/foreign origin even with the header', () => {
    const { next } = run({
      ...base,
      origin: 'https://evil.example',
      'x-requested-with': 'XMLHttpRequest',
    });
    expect(next).not.toHaveBeenCalled();
  });
});
