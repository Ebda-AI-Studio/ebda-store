import { describe, it, expect } from 'vitest';
import {
  cachegenPlacement,
  shardOf,
  CACHEGEN_SHARD,
} from '../../apps/api/src/cf/auth-state-client';

describe('cachegen placement override', () => {
  it('unset is today: instance "cachegen", no hint', () => {
    expect(cachegenPlacement({})).toEqual({ name: 'cachegen', hint: undefined });
  });
  it('a valid name and hint are honoured', () => {
    expect(
      cachegenPlacement({ CACHEGEN_DO_NAME: 'cachegen-me', CACHEGEN_LOCATION_HINT: 'me' })
    ).toEqual({
      name: 'cachegen-me',
      hint: 'me',
    });
  });
  it('an invalid name can never address an auth shard or another namespace', () => {
    for (const bad of ['shard-0', 'jti', '../x', 'cachegen X', 'cachegen' + 'a'.repeat(40), '']) {
      expect(cachegenPlacement({ CACHEGEN_DO_NAME: bad }).name).toBe('cachegen');
    }
  });
  it('an unknown hint is ignored', () => {
    expect(cachegenPlacement({ CACHEGEN_LOCATION_HINT: 'mars' }).hint).toBeUndefined();
  });
  it('cache generation keys still route to the cachegen instance, never an auth shard', () => {
    expect(shardOf('cachegen:public:')).toBe(CACHEGEN_SHARD);
    expect(shardOf('jti:deny:x')).toBeGreaterThanOrEqual(0);
  });
});
