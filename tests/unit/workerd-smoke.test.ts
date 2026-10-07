import { describe, expect, it } from 'vitest';
import { CHECKS, smokeProblems } from '../../scripts/ci/workerd-smoke.mjs';

const answer = (overrides: Record<string, { status: number; body?: string }> = {}) =>
  CHECKS.map(c => ({
    ...c,
    ...{ status: c.want, body: c.path === '/health' ? '{"status":"ok"}' : 'Alpha Store' },
    ...overrides[c.path],
  }));

describe('workerd smoke verdict', () => {
  it('the expected shapes pass', () => {
    expect(smokeProblems(answer())).toEqual([]);
  });
  it('the 2026-10-08 incident shape (500 on /health) fails', () => {
    expect(smokeProblems(answer({ '/health': { status: 500 } }))).toHaveLength(1);
  });
  it('a 5xx on the tenant-scoped read fails even when /health is fine', () => {
    expect(
      smokeProblems(answer({ '/api/v1/public/stores/smoke-no-such-store': { status: 503 } }))
    ).toHaveLength(1);
  });
  it('no response at all (Worker never booted) fails', () => {
    expect(smokeProblems(answer({ '/health': { status: 0 } }))).toHaveLength(1);
  });
  it('an unknown store answering 200 (resolver defaulting to a store) fails', () => {
    expect(
      smokeProblems(answer({ '/api/v1/public/stores/smoke-no-such-store': { status: 200 } }))
    ).toHaveLength(1);
  });
  it('a 200 /health that is not status ok fails', () => {
    expect(
      smokeProblems(answer({ '/health': { status: 200, body: '{"status":"bad"}' } }))
    ).toHaveLength(1);
  });
});
