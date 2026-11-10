/**
 * Issue 2351: the flatten script's cache purge was gated on REDIS_URL as a
 * whole, so from a laptop (production Redis is private-network only) it also
 * skipped the storefront TAG purge — an HTTPS call that needs no Redis and the
 * one layer that does not expire on its own. The two layers are now gated
 * independently, and purging is the default.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('@ebda/database', () => ({ prisma: {}, withMoneyTx: vi.fn() }));

import {
  bustCaches,
  cachePurgeList,
  type BustDeps,
} from '../../scripts/flatten-single-variant-products-2026-09-30';

function deps(over: Partial<BustDeps> = {}) {
  const lines: string[] = [];
  const d: BustDeps = {
    revalidate: vi.fn(async () => 'ok'),
    clearRedis: vi.fn(async () => undefined),
    redisUrl: undefined,
    log: l => lines.push(l),
    ...over,
  };
  return { d, lines };
}

describe('flatten script cache purge (issue 2351)', () => {
  it('purges the storefront tags with NO Redis configured', async () => {
    const { d, lines } = deps();
    await bustCaches('store-1', true, d);
    expect(d.revalidate).toHaveBeenCalledWith({
      tags: ['products:store-1', 'categories:store-1', 'bundles:store-1'],
    });
    expect(d.clearRedis).not.toHaveBeenCalled();
    expect(lines.join('\n')).toMatch(/storefront tags purged/);
    expect(lines.join('\n')).toMatch(/Redis not reachable from here/);
  });

  it('clears Redis too when REDIS_URL is set', async () => {
    const { d } = deps({ redisUrl: 'redis://x' });
    await bustCaches('store-1', true, d);
    expect(d.revalidate).toHaveBeenCalled();
    expect(d.clearRedis).toHaveBeenCalledWith('store-1');
  });

  it('a failed tag purge is reported, never silent, and Redis is still tried', async () => {
    const { d, lines } = deps({
      revalidate: vi.fn(async () => 'not-configured'),
      redisUrl: 'redis://x',
    });
    await bustCaches('store-1', true, d);
    expect(lines.join('\n')).toMatch(/storefront tag purge not-configured/);
    expect(d.clearRedis).toHaveBeenCalled();
  });

  it('--no-bust-caches purges nothing and says the tag layer does not expire', async () => {
    const { d, lines } = deps({ redisUrl: 'redis://x' });
    await bustCaches('store-1', false, d);
    expect(d.revalidate).not.toHaveBeenCalled();
    expect(d.clearRedis).not.toHaveBeenCalled();
    expect(lines.join('\n')).toMatch(/does NOT expire on its own/);
  });

  it('purging is the default: only --no-bust-caches turns it off', () => {
    const src = readFileSync(
      join(__dirname, '../../scripts/flatten-single-variant-products-2026-09-30.ts'),
      'utf8'
    );
    expect(src).toMatch(/const bust = !process\.argv\.includes\('--no-bust-caches'\)/);
  });

  // The tag list vs invalidateStoreProductCaches check is behavioural: flatten-purge-tags-match-invalidator.test.ts
});
