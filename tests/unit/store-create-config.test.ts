/**
 * Ruling NZ-PG-9: STORE_CREATE_ON_DO unset after the cutover is reported loudly (P1 + /health `store_create`), not silently left
 * to break store creation. It is NOT set by the deploy (cutover step 7 sets it after the platform copies).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  workers: true,
  hyperdrive: false,
  d1: true,
  markers: new Set<string>(),
  alerts: [] as Array<Record<string, unknown>>,
}));
vi.mock('@api/lib/runtime', () => ({
  get isWorkers() {
    return h.workers;
  },
}));
vi.mock('@api/cf/bindings', () => ({
  cfBindings: () => ({
    ...(h.d1 ? { PLATFORM_DB: {} } : {}),
    ...(h.hyperdrive ? { HYPERDRIVE: {} } : {}),
  }),
}));
vi.mock('@api/services/alerts.service', () => ({
  sendAlert: async (a: Record<string, unknown>) => void h.alerts.push(a),
}));
vi.mock('@api/lib/logger', () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@api/services/platform/cutover', () => ({
  FAMILY_MODELS: { billing: [], access: [], platform: [] },
  platformFamilyOnD1: async (f: string) => h.markers.has(f),
}));

import {
  alertIfStoreCreateMisconfigured,
  resetStoreCreateAlert,
  storeCreateState,
} from '@api/lib/store-create-config';

const T0 = 100 * 3_600_000;

beforeEach(() => {
  vi.stubEnv('STORE_CREATE_ON_DO', '');
  h.workers = true;
  h.hyperdrive = false;
  h.d1 = true;
  h.markers = new Set(['billing', 'access', 'platform']);
  h.alerts = [];
  resetStoreCreateAlert();
});

describe('storeCreateState', () => {
  it('the var set is on', async () => {
    expect(await storeCreateState({ STORE_CREATE_ON_DO: '1' })).toBe('on');
  });
  it('all markers set, no Hyperdrive, var unset = misconfigured', async () => {
    expect(await storeCreateState({})).toBe('misconfigured');
  });
  it('a marker missing, Hyperdrive present, a non-Worker or no D1 = still pending the cutover', async () => {
    h.markers.delete('platform');
    expect(await storeCreateState({})).toBe('pending-cutover');
    h.markers.add('platform');
    h.hyperdrive = true;
    expect(await storeCreateState({})).toBe('pending-cutover');
    h.hyperdrive = false;
    h.workers = false;
    expect(await storeCreateState({})).toBe('pending-cutover');
    h.workers = true;
    h.d1 = false;
    expect(await storeCreateState({})).toBe('pending-cutover');
  });
});

describe('alertIfStoreCreateMisconfigured', () => {
  it('pages a P1 once per 6 hours while misconfigured, never when fine', async () => {
    expect(await alertIfStoreCreateMisconfigured(T0)).toBe('misconfigured');
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]).toMatchObject({ level: 'p1', source: 'api.store_create_on_do_unset' });
    await alertIfStoreCreateMisconfigured(T0 + 1_000);
    expect(h.alerts).toHaveLength(1);
    await alertIfStoreCreateMisconfigured(T0 + 6 * 3_600_000);
    expect(h.alerts).toHaveLength(2);
    h.markers.clear();
    resetStoreCreateAlert();
    await alertIfStoreCreateMisconfigured();
    expect(h.alerts).toHaveLength(2);
  });
});
