/** INSTAPAY-AUTO-1 S1: the global dedupe DB binding, fail-closed, reported on /health, and the foundation contract run on the REAL SQL. */
import { beforeEach, describe, expect, it } from 'vitest';
import { D1DuplicateIndex, duplicateIndexContract } from '@ebda/shared';
import { clearCfBindings, setCfBindings } from '../../apps/api/src/cf/bindings';
import { getDuplicateIndex, instapayAutoReady } from '../../apps/api/src/lib/instapay-dedupe';
import { healthPayload } from '../../apps/api/src/lib/health-payload';
import { buildWorld, d1Over } from '../helpers/instapay-auto-world';

beforeEach(() => clearCfBindings());

describe('S1 wiring', () => {
  it('no binding -> no index (the caller fails closed)', () => {
    expect(getDuplicateIndex()).toBeNull();
  });
  it('a binding -> a D1DuplicateIndex', () => {
    buildWorld();
    expect(getDuplicateIndex()).toBeInstanceOf(D1DuplicateIndex);
  });
  it('instapayAutoReady lists every missing piece by name and never a value', () => {
    const r = instapayAutoReady({});
    expect(r.ready).toBe(false);
    expect(r.missing).toEqual([
      'INSTAPAY_DEDUPE_DB',
      'EBDA_INSTAPAY_HANDLE',
      'INSTAPAY_BRIDGE_SECRET',
      'BRAIN_BRIDGE_URL',
    ]);
    buildWorld();
    expect(
      instapayAutoReady({
        EBDA_INSTAPAY_HANDLE: 'ebda@instapay',
        INSTAPAY_BRIDGE_SECRET: 'x'.repeat(16),
        BRAIN_BRIDGE_URL: 'https://brain.example/api/instapay/notify',
      })
    ).toEqual({ ready: true, missing: [] });
    expect(instapayAutoReady({ INSTAPAY_BRIDGE_SECRET: 'short' }).missing).toContain(
      'INSTAPAY_BRIDGE_SECRET'
    );
  });
  it('/health carries instapayAuto but a gap never degrades it (the mode defaults to off)', async () => {
    const body = await healthPayload({});
    expect(body.status).toBe('ok');
    expect(body.instapayAuto).toMatchObject({ ready: false });
  });
});

// The foundation contract against the production SQL (a fresh database per case).
describe('S1 foundation contract on the real dedupe schema', () => {
  duplicateIndexContract(
    async () => {
      const w = buildWorld();
      return new D1DuplicateIndex(d1Over(w.dd) as never);
    },
    { it, expect: expect as never }
  );
});
