/** The one structured log sink: JSON lines, ids only, the right console level; the retired-key warnings go through it. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logAuditEvent, logEvent } from '../src/audit-log';

afterEach(() => vi.restoreAllMocks());

describe('structured log sink', () => {
  it('logEvent writes one JSON line with the event and the given non-secret fields', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    logEvent('something_happened', { kid: 'k1' });
    expect(info).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(info.mock.calls[0][0]))).toEqual({
      event: 'something_happened',
      kid: 'k1',
    });
  });

  it('level error goes to console.error, info (default) does not', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    logEvent('bad', { kids: ['a', 'b'] }, 'error');
    expect(err).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(err.mock.calls[0][0]))).toEqual({ event: 'bad', kids: ['a', 'b'] });
    expect(info).not.toHaveBeenCalled();
  });

  it('the credential audit event keeps its shape: event and user id only', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    logAuditEvent('mfa_recovery_codes_regenerated', 'u1');
    expect(JSON.parse(String(info.mock.calls[0][0]))).toEqual({
      event: 'mfa_recovery_codes_regenerated',
      userId: 'u1',
    });
  });
});
