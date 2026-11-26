import { describe, expect, it } from 'vitest';
import { parseAdminInvite } from './admin-invite-schema';

const base = { email: 'a@b.co', firstName: 'A', lastName: 'B' };

describe('parseAdminInvite', () => {
  it('accepts store_admin', () => {
    expect(parseAdminInvite({ ...base, role: 'store_admin' }).ok).toBe(true);
  });

  it('super_admin gets a role-specific bilingual 400, never the generic message', () => {
    const r = parseAdminInvite({ ...base, role: 'super_admin' });
    expect(r.ok).toBe(false);
    if (r.ok !== false) throw new Error('unreachable');
    const err = r.body.error as { code: string; details: Record<string, unknown> };
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.details.role).toHaveLength(1);
    expect(err.details.messageAr).toMatch(/تهيئة الأدمن/);
    expect(err.details.messageEn).toMatch(/bootstrap/);
  });

  it('a non-role failure falls through to the shared handler', () => {
    expect(parseAdminInvite({ ...base, email: 'nope', role: 'store_admin' }).ok).toBe('generic');
    expect(parseAdminInvite({ ...base, email: 'nope', role: 'super_admin' }).ok).toBe('generic');
  });
});
