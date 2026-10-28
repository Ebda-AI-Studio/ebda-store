// @vitest-environment jsdom
/** ETA connection card (Ruling ETA-1): secrets come back masked and a masked value is sent back unchanged. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { apiGet, apiPut, apiPost } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPut: vi.fn(),
  apiPost: vi.fn(),
}));
vi.mock('@/lib/api', () => ({ apiGet, apiPut, apiPost }));
vi.mock('next-intl', () => {
  const t = Object.assign(
    (key: string, vals?: Record<string, unknown>) =>
      vals ? `${key}:${JSON.stringify(vals)}` : key,
    { has: () => true }
  );
  return { useTranslations: () => t, useLocale: () => 'en' };
});

import { EtaConnectionCard } from './EtaConnectionCard';

const conn = (o = {}) => ({
  connected: true,
  enabled: true,
  environment: 'preprod',
  clientId: '****1234',
  clientSecret: '****9999',
  posSerial: 'POS-1',
  posPreSharedKey: null,
  branchCode: '0',
  activityCode: '4719',
  defaultItemCode: 'EG-1-1',
  address: { governate: 'Cairo', regionCity: 'Nasr City', street: 'Abbas', buildingNumber: '5' },
  signingBridgeUrl: null,
  lastCheckStatus: null,
  lastCheckedAt: null,
  ...o,
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('EtaConnectionCard', () => {
  it('shows the masked secret, never a plain one, and saves it back masked', async () => {
    apiGet.mockResolvedValue({ data: { connection: conn() }, error: null });
    apiPut.mockResolvedValue({ data: { connection: conn() }, error: null });
    render(<EtaConnectionCard storeId="s1" />);
    const secret = (await screen.findByLabelText('clientSecret')) as HTMLInputElement;
    expect(secret.value).toBe('****9999');
    expect(secret.type).toBe('password');
    fireEvent.click(screen.getByText('save'));
    await waitFor(() => expect(apiPut).toHaveBeenCalled());
    const [url, body] = apiPut.mock.calls[0];
    expect(url).toBe('/api/v1/stores/s1/eta/connection');
    expect(body.clientSecret).toBe('****9999');
    expect(body.signingBridgeUrl).toBeNull();
    await screen.findByText('saved');
  });

  it('check button reports a refusal code', async () => {
    apiGet.mockResolvedValue({ data: { connection: conn() }, error: null });
    apiPost.mockResolvedValue({ data: { ok: false, status: 'invalid_presharedkey' }, error: null });
    render(<EtaConnectionCard storeId="s1" />);
    fireEvent.click(await screen.findByText('check'));
    await screen.findByText('checkRefused:{"code":"invalid_presharedkey"}');
  });
});
