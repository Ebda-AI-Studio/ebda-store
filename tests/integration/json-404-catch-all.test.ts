/**
 * Info finding (2026-09-22 security audit): an unknown API route fell
 * through to Express's own default handler, which returns HTML
 * ("Cannot GET /x") and fingerprints the framework. A JSON 404 catch-all is
 * now mounted after every real router in `apps/api/src/index.ts`.
 *
 * Also asserts the catch-all does NOT shadow a real, currently-mounted
 * route — the risk this kind of change always carries, and the reason the
 * task explicitly asked to "run the API route tests" after adding it.
 */
import { describe, it, expect } from 'vitest';
import { API_ORIGIN, API_BASE } from '../helpers/api-base';

describe('JSON 404 catch-all', () => {
  it('an unknown route returns a JSON 404, not HTML', async () => {
    const r = await fetch(`${API_BASE}/this-route-does-not-exist-${Date.now()}`);
    expect(r.status).toBe(404);
    expect(r.headers.get('content-type') ?? '').toContain('application/json');

    const body = await r.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.message).toContain('this-route-does-not-exist');
  });

  it('an unknown route under the versioned prefix also gets the JSON 404', async () => {
    const r = await fetch(`${API_ORIGIN}/some-completely-unknown-path-${Date.now()}`);
    expect(r.status).toBe(404);
    const body = await r.json();
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('does not shadow a real route — /health still 200s as JSON', async () => {
    const r = await fetch(`${API_ORIGIN}/health`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.status).toBe('ok');
  });

  it('does not shadow a real, authenticated route — /auth/me still 401s (not 404) with no token', async () => {
    const r = await fetch(`${API_BASE}/auth/me`);
    expect(r.status).toBe(401);
    const body = await r.json();
    expect(body.error.code).not.toBe('NOT_FOUND');
  });
});
