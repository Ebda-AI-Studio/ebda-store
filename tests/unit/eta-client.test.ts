import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EtaClient, clearEtaTokenCache } from '@api/lib/eta/client';
import { BridgeSigner, NoopSigner } from '@api/lib/eta/signer';

const creds = { clientId: 'cid', clientSecret: 's3cret', posSerial: 'POS-1', preSharedKey: 'psk' };
const tokenRes = () =>
  new Response(JSON.stringify({ access_token: 'T', token_type: 'Bearer', expires_in: 3600 }), {
    status: 200,
  });
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

beforeEach(() => clearEtaTokenCache());

describe('EtaClient', () => {
  it('authenticates with the documented headers and submits a batch', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(tokenRes())
      .mockResolvedValueOnce(
        json(202, {
          submissionUUID: 'sub1',
          acceptedDocuments: [{ uuid: 'u1', longId: 'L1', receiptNumber: 'R1' }],
          rejectedDocuments: [],
        })
      );
    const out = await new EtaClient('preprod', creds, f).submitReceipts([{ a: 1 }]);
    expect(out).toMatchObject({ kind: 'ok', submissionUuid: 'sub1' });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('https://id.preprod.eta.gov.eg/connect/token');
    expect(init.headers).toMatchObject({ posserial: 'POS-1', presharedkey: 'psk' });
    expect(String(init.body)).toContain('grant_type=client_credentials');
    expect(f.mock.calls[1][0]).toBe(
      'https://api.preprod.invoicing.eta.gov.eg/api/v1/receiptsubmissions'
    );
    expect(JSON.parse(f.mock.calls[1][1].body)).toEqual({ receipts: [{ a: 1 }], signatures: [] });
  });

  it('reuses the token inside its 55 minute window', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(tokenRes())
      .mockResolvedValue(
        json(202, { submissionUUID: 's', acceptedDocuments: [], rejectedDocuments: [] })
      );
    const c = new EtaClient('prod', creds, f);
    await c.submitReceipts([]);
    await c.submitReceipts([]);
    expect(f.mock.calls.filter(c => String(c[0]).includes('connect/token'))).toHaveLength(1);
  });

  it.each([
    [429, { 'retry-after': '7' }, 7000],
    [503, {}, 2000],
  ])('status %s is a transient retry', async (status, headers, afterMs) => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(tokenRes())
      .mockResolvedValueOnce(json(status, {}, headers));
    expect(await new EtaClient('prod', creds, f).submitReceipts([])).toEqual({
      kind: 'retry',
      reason: status === 429 ? 'throttled' : 'unavailable',
      afterMs,
    });
  });

  it('treats a network error as a retry and bad credentials as fatal', async () => {
    const net = vi.fn().mockRejectedValue(new Error('boom'));
    expect((await new EtaClient('prod', creds, net).submitReceipts([])).kind).toBe('retry');
    const bad = vi.fn().mockResolvedValue(json(400, { error: 'invalid_presharedkey' }));
    expect(await new EtaClient('prod', creds, bad).submitReceipts([])).toMatchObject({
      kind: 'fatal',
      code: 'auth_invalid_presharedkey',
    });
  });

  it('maps DuplicateSubmission to a delayed retry and BadStructure to fatal', async () => {
    const dup = vi
      .fn()
      .mockResolvedValueOnce(tokenRes())
      .mockResolvedValueOnce(
        json(422, { error: { code: 'DuplicateSubmission' } }, { 'retry-after': '600' })
      );
    expect(await new EtaClient('prod', creds, dup).submitReceipts([])).toMatchObject({
      kind: 'retry',
      afterMs: 600000,
    });
    clearEtaTokenCache();
    const bs = vi
      .fn()
      .mockResolvedValueOnce(tokenRes())
      .mockResolvedValueOnce(json(400, { error: { code: 'BadStructure', message: 'x' } }));
    expect(await new EtaClient('prod', creds, bs).submitReceipts([])).toMatchObject({
      kind: 'fatal',
      code: 'BadStructure',
    });
  });

  it('never leaks the secret into an outcome', async () => {
    const bad = vi.fn().mockResolvedValue(json(400, { error: 'unauthorized_client' }));
    const out = await new EtaClient('prod', creds, bad).submitReceipts([]);
    expect(JSON.stringify(out)).not.toContain('s3cret');
  });
});

describe('getSubmission', () => {
  it('reports InProgress, then per-receipt verdicts', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(tokenRes())
      .mockResolvedValueOnce(json(200, { status: 'InProgress' }))
      .mockResolvedValueOnce(
        json(200, {
          status: 'Valid',
          receipts: [
            { uuid: 'u1', status: 'Valid', longId: 'L1' },
            { uuid: 'u2', status: 'Invalid', errors: [{ error: { errorCode: 'CV307' } }] },
          ],
        })
      );
    const c = new EtaClient('prod', creds, f);
    expect(await c.getSubmission('sub')).toEqual({ kind: 'in_progress' });
    expect(f.mock.calls[1][0]).toContain('/api/v1/receiptsubmissions/sub/details');
    expect(await c.getSubmission('sub')).toEqual({
      kind: 'done',
      receipts: [
        { uuid: 'u1', status: 'Valid', longId: 'L1', errorCode: undefined },
        { uuid: 'u2', status: 'Invalid', longId: undefined, errorCode: 'CV307' },
      ],
    });
  });
});

describe('signers', () => {
  it('noop signs nothing', async () => {
    expect(await new NoopSigner().sign()).toBeNull();
  });
  it('bridge posts the serialization and returns Base64', async () => {
    const f = vi.fn().mockResolvedValue(json(200, { signature: 'QUJD' }));
    const s = await new BridgeSigner('https://sign.example.com/x', 'tok', f).sign({
      uuid: 'u',
      serialized: '"A""1"',
    });
    expect(s).toEqual({ signatureType: 'I', value: 'QUJD' });
    expect(JSON.parse(f.mock.calls[0][1].body)).toMatchObject({ uuid: 'u', format: 'CAdES-BES' });
    const bad = vi.fn().mockResolvedValue(json(200, { signature: '<script>' }));
    await expect(
      new BridgeSigner('https://s.example.com', undefined, bad).sign({ uuid: 'u', serialized: 'x' })
    ).rejects.toThrow();
  });
});
