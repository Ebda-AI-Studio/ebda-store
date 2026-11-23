import { describe, expect, it } from 'vitest';
import { redactSensitiveQuery } from '../../packages/shared/src/utils/sentry-url-scrub';

describe('sensitive query keys with an array suffix (linear suffix strip)', () => {
  it.each(['token[]', 'token[0]', 'Token[abc]', 'token%5B%5D'])('redacts %s', key => {
    expect(redactSensitiveQuery(`https://x.test/p?${key}=secret1`)).not.toContain('secret1');
  });

  it('leaves a non-sensitive array key alone', () => {
    expect(redactSensitiveQuery('https://x.test/p?tag[]=v1')).toContain('v1');
  });

  // Mutation check: the old /\[[^\]]*\]$/ regex is quadratic on this shape; a linear strip stays instant.
  it('does not blow up on a long run of open brackets', () => {
    const hostile = `https://x.test/p?${'['.repeat(100_000)}=v1`;
    const t0 = performance.now();
    redactSensitiveQuery(hostile);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});
