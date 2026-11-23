/**
 * SELF-SERVICE gap A10: a VERIFIED merchant asks to change its VAT registration. The old verified state stays while the request
 * waits; the AI pre-check only extracts fields, plain code compares, flags go to the super-admin and a mismatch is flagged never
 * approved; the request needs a server-issued single-use confirm token bound to the payload; approve / reject stay super-admin.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

const STORE = '11111111-1111-4111-8111-111111111111';
const PDF = Buffer.from('%PDF-1.4 tax card');

const m = vi.hoisted(() => ({
  settings: new Map<string, unknown>(),
  getProfile: vi.fn(),
  apply: vi.fn(),
  review: vi.fn(),
  read: vi.fn(),
  putPrivate: vi.fn(),
  deletePrivate: vi.fn(),
  audit: vi.fn(),
  loseClaim: false,
  createFail: null as null | Error,
  alert: vi.fn(),
  keyN: 0,
  settingsDown: false,
  beforeClaim: null as null | (() => void),
  upsertFail: false,
}));

vi.mock('@api/middleware/auth', async () => {
  const real = await vi.importActual<typeof import('@api/middleware/auth')>('@api/middleware/auth');
  return {
    ...real,
    authenticate: (req: any, _res: any, next: any) => {
      req.user = { userId: 'u1', role: req.header('x-role') ?? 'store_admin' };
      next();
    },
  };
});
vi.mock('@api/middleware/require-mfa', () => ({
  requireMfaEnrolled: (_q: any, _s: any, n: any) => n(),
}));
vi.mock('@api/middleware/store-access', () => ({
  requireStoreAccess: (_q: any, _s: any, n: any) => n(),
}));
vi.mock('@api/middleware/tenant-context', () => ({
  tenantContext: (_q: any, _s: any, n: any) => n(),
}));
vi.mock('@api/middleware/security', () => ({
  uploadLimiter: (_q: any, _s: any, n: any) => n(),
  dailyUploadLimiter: (_q: any, _s: any, n: any) => n(),
  adminReadLimiter: (_q: any, _s: any, n: any) => n(),
  auditLog: m.audit,
}));
vi.mock('@api/lib/platform-scope', () => ({
  withPlatformUser: (_id: string, fn: () => unknown) => fn(),
  platformHubOnD1: async () => false,
}));
vi.mock('@api/services/tax-change-claim', () => ({ claimPendingChangeD1: async () => null }));
vi.mock('@api/services/alerts.service', () => ({
  sendAlert: (o: any) => {
    m.alert(o);
    return Promise.resolve({});
  },
}));
vi.mock('@api/services/storage.service', () => ({
  StorageService: {
    putPrivate: m.putPrivate,
    deletePrivate: m.deletePrivate,
    getPrivate: async () => ({ body: PDF }),
  },
}));
vi.mock('@api/lib/ai/tax-document-reader', () => ({ readTaxDocument: m.read }));
vi.mock('@api/services/tax-profile.service', () => ({
  TaxProfileService: { get: m.getProfile, review: m.review },
  applyApprovedTaxChange: m.apply,
  inReviewScope: (_a: string, _s: string, fn: () => unknown) => fn(),
  listProfilesForReview: async () => [],
  sniffTaxDocumentMime: (b: Buffer) =>
    b.subarray(0, 5).toString('latin1') === '%PDF-'
      ? 'application/pdf'
      : b[0] === 0x89
        ? 'image/png'
        : null,
}));
vi.mock('@ebda/database', () => ({
  prisma: {
    systemSetting: {
      findUnique: async ({ where }: any) => {
        if (m.settingsDown) throw new Error('d1 down');
        return m.settings.has(where.key) ? { value: m.settings.get(where.key) } : null;
      },
      findMany: async ({ where }: any) =>
        [...m.settings]
          .filter(([k]) => k.startsWith(where.key.startsWith))
          .map(([key, value]) => ({ key, value })),
      create: async ({ data }: any) => {
        await Promise.resolve();
        if (m.createFail) throw m.createFail;
        if (m.settings.has(data.key)) throw new Error('unique');
        m.settings.set(data.key, data.value);
      },
      upsert: async ({ where, create }: any) => {
        if (m.upsertFail) throw new Error('d1 down');
        m.settings.set(where.key, create.value);
      },
      deleteMany: async ({ where }: any) => {
        if (m.settingsDown) throw new Error('d1 down');
        m.beforeClaim?.();
        const row = m.settings.get(where.key) as { id?: string } | undefined;
        const idFilter = where.value?.path?.[0] === 'id' ? where.value.equals : undefined;
        if (idFilter !== undefined && row?.id !== idFilter) return { count: 0 };
        return { count: m.loseClaim ? 0 : m.settings.delete(where.key) ? 1 : 0 };
      },
    },
  },
  withUser: (_id: string, fn: () => unknown) => fn(),
}));

let app: Express;
beforeAll(async () => {
  const tax = (await import('@api/routes/tax.routes')).default;
  const admin = (await import('@api/routes/platform-tax.routes')).default;
  const { errorHandler } = await import('@api/middleware/error-handler');
  app = express();
  app.use(express.json());
  app.use('/stores', tax);
  app.use('/admin', admin);
  app.use(errorHandler as any);
});
beforeEach(() => {
  m.settings.clear();
  m.loseClaim = false;
  m.settingsDown = false;
  m.beforeClaim = null;
  m.upsertFail = false;
  m.createFail = null;
  m.alert.mockReset();
  m.keyN = 0;
  for (const f of [m.getProfile, m.apply, m.review, m.read, m.putPrivate, m.deletePrivate, m.audit])
    f.mockReset();
  m.getProfile.mockResolvedValue({ status: 'verified' });
  m.putPrivate.mockImplementation(async () => ({ key: `stores/s/tax-documents/x${m.keyN++}.pdf` }));
  m.read.mockResolvedValue({
    taxRegistrationNumber: '123-456-789',
    legalName: 'شركه النور',
    looksEdited: false,
    confidence: 0.9,
  });
  m.apply.mockResolvedValue(undefined);
  m.deletePrivate.mockResolvedValue(undefined);
  m.audit.mockResolvedValue(undefined);
});

const send = (role: string, over: Record<string, string> = {}, file = PDF) => {
  let r = request(app)
    .post(`/stores/${STORE}/tax/change-request`)
    .set('x-role', role)
    .field('taxRegistrationNumber', over.trn ?? '123456789')
    .field('legalName', over.name ?? 'شركة النور')
    .field('kind', 'tax_card');
  if (over.token) r = r.field('confirmToken', over.token);
  return r.attach('file', file, 'card.pdf');
};
const preview = async (over: Record<string, string> = {}) =>
  (await send('store_admin', over)).body.data.confirmToken as string;

describe('A10 change request on a verified registration', () => {
  it('first call is a preview with a token and creates nothing', async () => {
    const res = await send('store_admin');
    expect(res.status).toBe(200);
    expect(res.body.data.confirmationRequired).toBe(true);
    expect(res.body.data.confirmToken).toEqual(expect.any(String));
    expect(m.settings.size).toBe(0);
    expect(m.putPrivate).not.toHaveBeenCalled();
  });

  it('confirming creates a pending row and the verified profile is never touched', async () => {
    const token = await preview();
    const res = await send('store_admin', { token });
    expect(res.status).toBe(201);
    expect(m.settings.has(`tax.change.${STORE}`)).toBe(true);
    expect(m.apply).not.toHaveBeenCalled();
    expect(m.review).not.toHaveBeenCalled();
    const mine = await request(app).get(`/stores/${STORE}/tax/change-request`);
    expect(mine.body.data.request.taxRegistrationNumber).toBe('123456789');
    expect(JSON.stringify(mine.body)).not.toMatch(/precheck|flags|storageKey/);
    expect(m.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'tax_profile.change_requested' })
    );
  });

  it('a clean read (alef and ta-marbuta spelling variants) is "clean" but still waits for a human', async () => {
    const token = await preview();
    await send('store_admin', { token });
    const list = await request(app)
      .get('/admin/tax-verification/change-requests')
      .set('x-role', 'super_admin');
    expect(list.body.data.requests[0].precheck.status).toBe('clean');
    expect(list.body.data.requests[0].storageKey).toBeUndefined();
    expect(m.apply).not.toHaveBeenCalled();
  });

  it('a mismatch is flagged, never approved, and reaches the super-admin queue', async () => {
    m.read.mockResolvedValue({
      taxRegistrationNumber: '999999999',
      legalName: 'Other Co',
      looksEdited: false,
      confidence: 0.95,
    });
    const token = await preview();
    expect((await send('store_admin', { token })).status).toBe(201);
    const list = await request(app)
      .get('/admin/tax-verification/change-requests')
      .set('x-role', 'super_admin');
    const p = list.body.data.requests[0].precheck;
    expect(p.status).toBe('flagged');
    expect(p.flags).toEqual(expect.arrayContaining(['trn_mismatch', 'name_mismatch']));
    expect(m.apply).not.toHaveBeenCalled();
  });

  it('an unreadable or unavailable pre-check is flagged not_pre_checked (a PDF, AI off)', async () => {
    m.read.mockResolvedValue(null);
    const token = await preview();
    await send('store_admin', { token });
    const list = await request(app)
      .get('/admin/tax-verification/change-requests')
      .set('x-role', 'super_admin');
    expect(list.body.data.requests[0].precheck.flags).toEqual(['not_pre_checked']);
  });

  it('a low-confidence or edited-looking read is flagged', async () => {
    m.read.mockResolvedValue({
      taxRegistrationNumber: '123456789',
      legalName: 'شركة النور',
      looksEdited: true,
      confidence: 0.3,
    });
    const token = await preview();
    await send('store_admin', { token });
    const list = await request(app)
      .get('/admin/tax-verification/change-requests')
      .set('x-role', 'super_admin');
    expect(list.body.data.requests[0].precheck.flags).toEqual(
      expect.arrayContaining(['looks_edited', 'low_confidence'])
    );
  });

  it('an edited payload with a valid token is refused', async () => {
    const token = await preview();
    const res = await send('store_admin', { token, trn: '555555555' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFIRMATION_INVALID');
    expect(m.settings.size).toBe(0);
  });

  it('an edited file with a valid token is refused', async () => {
    const token = await preview();
    const res = await send('store_admin', { token }, Buffer.from('%PDF-1.4 another file'));
    expect(res.body.error.code).toBe('CONFIRMATION_INVALID');
  });

  it('a replayed token is refused', async () => {
    const token = await preview();
    expect((await send('store_admin', { token })).status).toBe(201);
    await request(app).delete(`/stores/${STORE}/tax/change-request`).set('x-role', 'store_admin');
    const again = await send('store_admin', { token });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('CONFIRMATION_USED');
  });

  it('only a verified registration uses a change request', async () => {
    m.getProfile.mockResolvedValue({ status: 'pending' });
    const res = await send('store_admin');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TAX_CHANGE_NOT_APPLICABLE');
  });

  it('a second request while one is pending is refused', async () => {
    const token = await preview();
    await send('store_admin', { token });
    const res = await send('store_admin');
    expect(res.body.error.code).toBe('TAX_CHANGE_PENDING');
  });

  it('rejects a bad TRN and a non-document file', async () => {
    expect((await send('store_admin', { trn: '12' })).status).toBe(400);
    expect((await send('store_admin', {}, Buffer.from('plain text'))).body.error.code).toBe(
      'INVALID_FILE_TYPE'
    );
  });

  it('a customer-level role cannot send a request; super_admin keeps the override', async () => {
    expect((await send('customer')).status).toBe(403);
    expect((await send('super_admin')).status).toBe(200);
  });

  it('the merchant can withdraw: row and evidence object are removed', async () => {
    const token = await preview();
    await send('store_admin', { token });
    const res = await request(app)
      .delete(`/stores/${STORE}/tax/change-request`)
      .set('x-role', 'store_admin');
    expect(res.status).toBe(200);
    expect(m.settings.has(`tax.change.${STORE}`)).toBe(false);
    expect(m.deletePrivate).toHaveBeenCalledWith('stores/s/tax-documents/x0.pdf');
  });

  it('a failed create does not delete the merchant last rejection notice', async () => {
    m.settings.set(`tax.change-result.${STORE}`, { reason: 'earlier reason', at: 'x' });
    const token = await preview();
    m.createFail = new Error('d1 down');
    expect((await send('store_admin', { token })).status).toBe(500);
    expect(m.settings.has(`tax.change-result.${STORE}`)).toBe(true);
    m.createFail = null;
    expect((await send('store_admin', { token })).status).toBe(201);
    expect(m.settings.has(`tax.change-result.${STORE}`)).toBe(false); // a new request does clear it
  });

  it('a failed R2 upload does not burn the confirm token', async () => {
    const token = await preview();
    m.putPrivate.mockRejectedValueOnce(new Error('r2 down'));
    expect((await send('store_admin', { token })).status).toBe(500);
    expect(m.settings.size).toBe(0);
    expect((await send('store_admin', { token })).status).toBe(201);
  });

  it('a failed row write does not burn the token and leaves no orphaned upload', async () => {
    const token = await preview();
    m.createFail = new Error('d1 down');
    expect((await send('store_admin', { token })).status).toBe(500);
    expect(m.deletePrivate).toHaveBeenCalledWith('stores/s/tax-documents/x0.pdf');
    m.createFail = null;
    expect((await send('store_admin', { token })).status).toBe(201);
  });

  it('two concurrent confirms make exactly one request; the other is a clear 409 and its upload is removed', async () => {
    const t1 = await preview();
    // a slow upload keeps both requests past the pending check before either writes its row
    m.putPrivate.mockImplementation(async () => {
      await new Promise(r => setTimeout(r, 30));
      return { key: `stores/s/tax-documents/x${m.keyN++}.pdf` };
    });
    const [a, b] = await Promise.all([
      send('store_admin', { token: t1 }),
      send('store_admin', { token: t1 }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.body.error.code).toBe('TAX_CHANGE_PENDING');
    expect([...m.settings.keys()].filter(k => k.startsWith('tax.change.'))).toHaveLength(1);
    expect(m.deletePrivate).toHaveBeenCalledTimes(1);
    expect(m.putPrivate).toHaveBeenCalledTimes(2);
  });

  it('a replay after withdraw is refused and leaves no row or object behind', async () => {
    const token = await preview();
    await send('store_admin', { token });
    await request(app).delete(`/stores/${STORE}/tax/change-request`).set('x-role', 'store_admin');
    m.deletePrivate.mockClear();
    const again = await send('store_admin', { token });
    expect(again.body.error.code).toBe('CONFIRMATION_USED');
    expect(m.settings.has(`tax.change.${STORE}`)).toBe(false);
    expect(m.deletePrivate).toHaveBeenCalledTimes(1);
  });

  it('an audit failure after the row exists does not turn the request into a 500', async () => {
    const token = await preview();
    m.audit.mockRejectedValueOnce(new Error('audit down'));
    expect((await send('store_admin', { token })).status).toBe(201);
    expect(m.settings.has(`tax.change.${STORE}`)).toBe(true);
  });

  it('only a real signal pages at p1; a missing pre-check is info', async () => {
    m.read.mockResolvedValue(null);
    await send('store_admin', { token: await preview() });
    expect(m.alert.mock.calls[0][0].level).toBe('info');
    await request(app).delete(`/stores/${STORE}/tax/change-request`).set('x-role', 'store_admin');
    m.read.mockResolvedValue({
      taxRegistrationNumber: '999999999',
      legalName: 'x',
      looksEdited: false,
      confidence: 0.9,
    });
    await send('store_admin', { token: await preview() });
    expect(m.alert.mock.calls[1][0].level).toBe('p1');
  });
});

describe('A10 super-admin decision', () => {
  const pending = async () => {
    const token = await preview();
    await send('store_admin', { token });
  };

  it('a malformed queue row without requestedAt does not break the list and sorts first', async () => {
    await pending();
    m.settings.set('tax.change.22222222-2222-4222-8222-222222222222', { id: 'odd', precheck: {} });
    const list = await request(app)
      .get('/admin/tax-verification/change-requests')
      .set('x-role', 'super_admin');
    expect(list.status).toBe(200);
    expect(list.body.data.requests[0].id).toBe('odd');
  });

  it('store_admin cannot list, view the evidence of, or decide a change request', async () => {
    await pending();
    expect(
      (
        await request(app)
          .get('/admin/tax-verification/change-requests')
          .set('x-role', 'store_admin')
      ).status
    ).toBe(403);
    expect(
      (
        await request(app)
          .get(`/admin/tax-verification/${STORE}/change-request/file`)
          .set('x-role', 'store_admin')
      ).status
    ).toBe(403);
    const res = await request(app)
      .post(`/admin/tax-verification/${STORE}/change-decision`)
      .set('x-role', 'store_admin')
      .send({ decision: 'approve' });
    expect(res.status).toBe(403);
    expect(m.apply).not.toHaveBeenCalled();
  });

  it('approve applies the new identity and clears the request', async () => {
    await pending();
    const res = await request(app)
      .post(`/admin/tax-verification/${STORE}/change-decision`)
      .set('x-role', 'super_admin')
      .send({ decision: 'approve' });
    expect(res.status).toBe(200);
    expect(m.apply).toHaveBeenCalledWith(
      STORE,
      expect.objectContaining({ taxRegistrationNumber: '123456789', legalName: 'شركة النور' }),
      expect.objectContaining({ userId: 'u1' })
    );
    expect(m.settings.has(`tax.change.${STORE}`)).toBe(false);
    expect(m.deletePrivate).not.toHaveBeenCalled(); // the evidence became a profile document
  });

  it('two concurrent approvals apply once; the second is a no-op (also when it arrives after the first finished)', async () => {
    await pending();
    const go = () =>
      request(app)
        .post(`/admin/tax-verification/${STORE}/change-decision`)
        .set('x-role', 'super_admin')
        .send({ decision: 'approve' });
    const [a, b] = await Promise.all([go(), go()]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(m.apply).toHaveBeenCalledTimes(1);
  });

  it('a decision that loses the claim to a concurrent one does not apply', async () => {
    await pending();
    m.loseClaim = true; // the row was read, but another approval removed it first
    const res = await request(app)
      .post(`/admin/tax-verification/${STORE}/change-decision`)
      .set('x-role', 'super_admin')
      .send({ decision: 'approve' });
    expect(res.status).toBe(200);
    expect(res.body.data.noop).toBe(true);
    expect(m.apply).not.toHaveBeenCalled();
  });

  it('a decision claims the request it read: a withdraw + resubmit in between is not approved and the new evidence stays', async () => {
    await pending();
    const old = m.settings.get(`tax.change.${STORE}`) as { id: string };
    m.beforeClaim = () => {
      m.beforeClaim = null;
      m.settings.set(`tax.change.${STORE}`, { ...old, id: 'new-request-id' });
    };
    const res = await request(app)
      .post(`/admin/tax-verification/${STORE}/change-decision`)
      .set('x-role', 'super_admin')
      .send({ decision: 'approve' });
    expect(res.body.data.noop).toBe(true);
    expect(m.apply).not.toHaveBeenCalled();
    expect((m.settings.get(`tax.change.${STORE}`) as { id: string }).id).toBe('new-request-id');
    expect(m.deletePrivate).not.toHaveBeenCalled();
  });

  it('a restore that cannot put the request back pages p1', async () => {
    await pending();
    m.apply.mockRejectedValueOnce(new Error('boom'));
    m.createFail = new Error('d1 down'); // the restore create fails too
    const res = await request(app)
      .post(`/admin/tax-verification/${STORE}/change-decision`)
      .set('x-role', 'super_admin')
      .send({ decision: 'approve' });
    expect(res.status).toBe(500);
    expect(m.alert.mock.calls.some(c => c[0].level === 'p1' && /restore/i.test(c[0].title))).toBe(
      true
    );
  });

  it('a rejection whose notice cannot be saved still completes and pages p1', async () => {
    await pending();
    m.upsertFail = true;
    const res = await request(app)
      .post(`/admin/tax-verification/${STORE}/change-decision`)
      .set('x-role', 'super_admin')
      .send({ decision: 'reject', reason: 'name differs from the card' });
    expect(res.status).toBe(200);
    expect(m.deletePrivate).toHaveBeenCalled();
    expect(m.alert.mock.calls.some(c => c[0].level === 'p1' && /notice/i.test(c[0].title))).toBe(
      true
    );
  });

  it('a failed apply puts the request back so it can be decided again', async () => {
    await pending();
    m.apply.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app)
      .post(`/admin/tax-verification/${STORE}/change-decision`)
      .set('x-role', 'super_admin')
      .send({ decision: 'approve' });
    expect(res.status).toBe(500);
    expect(m.settings.has(`tax.change.${STORE}`)).toBe(true);
  });

  it('reject needs a reason, deletes the evidence and tells the merchant why', async () => {
    await pending();
    const bad = await request(app)
      .post(`/admin/tax-verification/${STORE}/change-decision`)
      .set('x-role', 'super_admin')
      .send({ decision: 'reject' });
    expect(bad.status).toBe(400);
    const res = await request(app)
      .post(`/admin/tax-verification/${STORE}/change-decision`)
      .set('x-role', 'super_admin')
      .send({ decision: 'reject', reason: 'name differs from the card' });
    expect(res.status).toBe(200);
    expect(m.apply).not.toHaveBeenCalled();
    expect(m.deletePrivate).toHaveBeenCalled();
    const mine = await request(app).get(`/stores/${STORE}/tax/change-request`);
    expect(mine.body.data.request).toBeNull();
    expect(mine.body.data.lastRejection.reason).toBe('name differs from the card');
  });

  it('a failing discard does not turn a committed revoke into a 500', async () => {
    await pending();
    m.review.mockResolvedValue({ status: 'revoked' });
    m.settingsDown = true; // the discard cannot reach system_settings
    m.deletePrivate.mockRejectedValue(new Error('r2 down'));
    const res = await request(app)
      .post(`/admin/tax-verification/${STORE}/decision`)
      .set('x-role', 'super_admin')
      .send({ decision: 'revoke', reason: 'no longer registered' });
    expect(res.status).toBe(200);
  });

  it('revoking the verified registration drops a pending request', async () => {
    await pending();
    m.review.mockResolvedValue({ status: 'revoked' });
    const res = await request(app)
      .post(`/admin/tax-verification/${STORE}/decision`)
      .set('x-role', 'super_admin')
      .send({ decision: 'revoke', reason: 'no longer registered' });
    expect(res.status).toBe(200);
    expect(m.settings.has(`tax.change.${STORE}`)).toBe(false);
    expect(m.deletePrivate).toHaveBeenCalled();
  });
});
