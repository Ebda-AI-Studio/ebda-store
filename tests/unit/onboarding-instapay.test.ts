/**
 * FIX-006: InstaPay can be enabled during onboarding. The helper writes the same
 * `payment_configs` row the admin payment-settings page writes, validated by the
 * same shared schema.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { findFirst, update, create, clearCache } = vi.hoisted(() => ({
  findFirst: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
  clearCache: vi.fn(),
}));

vi.mock('@force/database', () => ({
  prisma: { paymentConfig: { findFirst, update, create } },
}));
vi.mock('../../apps/api/src/services/payment.service', () => ({
  PaymentService: { clearCache },
}));

import { applyOnboardingInstapay } from '../../apps/api/src/services/onboarding-instapay';

const STORE = 'store-1';

beforeEach(() => {
  vi.resetAllMocks();
});

describe('applyOnboardingInstapay', () => {
  it('creates an enabled instapay config with the handle and default expiry', async () => {
    findFirst.mockResolvedValue(null);
    create.mockResolvedValue({ id: 'cfg-1' });
    const out = await applyOnboardingInstapay(STORE, { enabled: true, handle: 'amelia@instapay' });
    expect(out).toEqual({ instapay: true, configId: 'cfg-1' });
    const data = create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      storeId: STORE,
      provider: 'instapay',
      isEnabled: true,
      testMode: false,
      supportedCurrencies: ['EGP'],
      settings: { handle: 'amelia@instapay', expiryHours: 24 },
    });
    expect(clearCache).toHaveBeenCalledWith(STORE);
  });

  it('accepts a phone instead of a handle, and ignores blank fields', async () => {
    findFirst.mockResolvedValue(null);
    create.mockResolvedValue({ id: 'cfg-2' });
    await applyOnboardingInstapay(STORE, {
      enabled: true,
      handle: '',
      phone: '01012345678',
      accountName: '',
    });
    const settings = create.mock.calls[0][0].data.settings;
    expect(settings.phone).toBe('01012345678');
    expect(settings.handle).toBeUndefined();
    expect(settings.accountName).toBeUndefined();
  });

  it('refuses to enable with neither a handle nor a phone (422) and writes nothing', async () => {
    findFirst.mockResolvedValue(null);
    await expect(applyOnboardingInstapay(STORE, { enabled: true })).rejects.toMatchObject({
      statusCode: 422,
      code: 'INVALID_PAYMENT_SETTINGS',
    });
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses a malformed handle', async () => {
    findFirst.mockResolvedValue(null);
    await expect(
      applyOnboardingInstapay(STORE, { enabled: true, handle: 'not a handle' })
    ).rejects.toMatchObject({ code: 'INVALID_PAYMENT_SETTINGS' });
    expect(create).not.toHaveBeenCalled();
  });

  it('re-enabling keeps previously saved settings (expiry, notes) and merges new ones', async () => {
    findFirst.mockResolvedValue({
      id: 'cfg-3',
      settings: { handle: 'old@instapay', expiryHours: 72, noteEn: 'Thanks' },
    });
    update.mockResolvedValue({ id: 'cfg-3' });
    await applyOnboardingInstapay(STORE, { enabled: true, handle: 'new@instapay' });
    expect(create).not.toHaveBeenCalled();
    expect(update.mock.calls[0][0]).toMatchObject({
      where: { id: 'cfg-3' },
      data: {
        isEnabled: true,
        settings: { handle: 'new@instapay', expiryHours: 72, noteEn: 'Thanks' },
      },
    });
  });

  it('disabling turns an existing config off without validating settings', async () => {
    findFirst.mockResolvedValue({ id: 'cfg-4', settings: {} });
    update.mockResolvedValue({ id: 'cfg-4' });
    const out = await applyOnboardingInstapay(STORE, { enabled: false });
    expect(out).toEqual({ instapay: false, configId: 'cfg-4' });
    expect(update.mock.calls[0][0]).toMatchObject({ data: { isEnabled: false } });
  });

  it('disabling with no config is a no-op', async () => {
    findFirst.mockResolvedValue(null);
    const out = await applyOnboardingInstapay(STORE, { enabled: false });
    expect(out).toEqual({ instapay: false, configId: null });
    expect(update).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});
