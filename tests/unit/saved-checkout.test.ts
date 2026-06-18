import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  saveCheckoutInfo,
  loadCheckoutInfo,
  clearCheckoutInfo,
} from '../../apps/web/src/app/checkout/_lib/savedCheckout';

// Minimal localStorage shim for the node environment.
// The lib guards `typeof window === 'undefined'` — we provide both
// window and localStorage so the guards pass.
const store: Record<string, string> = {};
const localStorageMock = {
  getItem: (key: string) => store[key] ?? null,
  setItem: (key: string, value: string) => {
    store[key] = value;
  },
  removeItem: (key: string) => {
    delete store[key];
  },
  clear: () => {
    for (const k of Object.keys(store)) delete store[k];
  },
};

vi.stubGlobal('window', { localStorage: localStorageMock });
vi.stubGlobal('localStorage', localStorageMock);

beforeEach(() => localStorageMock.clear());

describe('savedCheckout', () => {
  const data = {
    firstName: 'A',
    lastName: 'B',
    phone: '+965',
    email: 'a@b.com',
    governorate: 'Hawalli',
    governorateAr: 'حولي',
    area: 'Salmiya',
    areaAr: 'السالمية',
    block: '1',
    street: '2',
    avenue: '',
    house: '3',
    floor: '',
    apartment: '',
    notes: '',
  };

  it('round-trips per store', () => {
    saveCheckoutInfo('store1', data);
    expect(loadCheckoutInfo('store1')?.area).toBe('Salmiya');
  });

  it('isolates by store', () => {
    saveCheckoutInfo('store1', data);
    expect(loadCheckoutInfo('store2')).toBeNull();
  });

  it('clears', () => {
    saveCheckoutInfo('store1', data);
    clearCheckoutInfo('store1');
    expect(loadCheckoutInfo('store1')).toBeNull();
  });

  it('returns null on corrupt json', () => {
    localStorageMock.setItem('force:checkout:store1', '{not json');
    expect(loadCheckoutInfo('store1')).toBeNull();
  });
});
