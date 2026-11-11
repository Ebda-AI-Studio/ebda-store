import { afterEach, describe, expect, it } from 'vitest';
import { GET } from './route';

describe('/health reports its commit (M-070)', () => {
  const prev = process.env.BUILD_COMMIT_SHA;
  afterEach(() => {
    if (prev === undefined) delete process.env.BUILD_COMMIT_SHA;
    else process.env.BUILD_COMMIT_SHA = prev;
  });
  it('returns the deployed commit', async () => {
    process.env.BUILD_COMMIT_SHA = 'abc123';
    const body = await GET().json();
    expect(body).toEqual({ status: 'ok', service: 'orders', commit: 'abc123' });
  });
  it('returns null, not a crash, when the var is unset', async () => {
    delete process.env.BUILD_COMMIT_SHA;
    expect((await GET().json()).commit).toBeNull();
  });
});
