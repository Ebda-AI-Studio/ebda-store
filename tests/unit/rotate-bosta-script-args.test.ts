import { describe, it, expect } from 'vitest';
import { parseArgs, assertRotationMode } from '../../scripts/rotate-bosta-webhook-secrets';

const args = (...a: string[]) => parseArgs(['node', 'x', ...a]);

describe('rotate-bosta-webhook-secrets', () => {
  it('is a dry run and a HARD rotation by default', () => {
    const a = args();
    expect(a.apply).toBe(false);
    expect(a.grace).toBe(false);
    expect(() => assertRotationMode(a)).not.toThrow();
    expect(args('--apply').apply).toBe(true);
    expect(args('--store', 'demo').store).toBe('demo');
  });

  it('--grace needs a reason', () => {
    expect(() => assertRotationMode(args('--grace'))).toThrow(/--reason/);
    expect(() => assertRotationMode(args('--grace', '--reason'))).toThrow(/--reason/);
    expect(() => assertRotationMode(args('--grace', '--reason', '--apply'))).toThrow(/--reason/);
  });

  it.each(['token leaked in logs', 'LEAK', 'compromised secret', 'exposed in Logpush', 'stolen'])(
    '--grace is refused for a leak: %s',
    reason => {
      expect(() => assertRotationMode(args('--grace', '--reason', reason))).toThrow(/refused/);
    }
  );

  it('--grace with a non-leak reason is allowed', () => {
    const a = args('--grace', '--reason', 'planned yearly rotation, 4 shipments in flight');
    expect(() => assertRotationMode(a)).not.toThrow();
    expect(a.grace).toBe(true);
  });
});
