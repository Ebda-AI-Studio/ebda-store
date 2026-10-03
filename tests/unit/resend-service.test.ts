import { describe, it, expect, beforeEach, vi } from 'vitest';

const {
  mockDomainsCreate,
  mockDomainsGet,
  mockDomainsRemove,
  mockEmailsSend,
  prismaUpdateMock,
  prismaFindUniqueMock,
} = vi.hoisted(() => ({
  mockDomainsCreate: vi.fn(),
  mockDomainsGet: vi.fn(),
  mockDomainsRemove: vi.fn(),
  mockEmailsSend: vi.fn(),
  prismaUpdateMock: vi.fn(),
  prismaFindUniqueMock: vi.fn(),
}));

vi.mock('resend', () => ({
  Resend: vi.fn().mockImplementation(function () {
    return {
      domains: {
        create: mockDomainsCreate,
        get: mockDomainsGet,
        remove: mockDomainsRemove,
      },
      emails: { send: mockEmailsSend },
    };
  }),
}));

vi.mock('@force/database', () => ({
  prisma: {
    store: { update: prismaUpdateMock, findUnique: prismaFindUniqueMock },
  },
}));

vi.mock('@api/config', () => ({
  config: { resendApiKey: 're_test_key' },
}));

import { ResendService } from '@api/services/resend.service';

describe('ResendService.provisionStoreDomain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a Resend domain and persists the returned id + initial records', async () => {
    prismaFindUniqueMock.mockResolvedValue({
      id: 'store-1',
      domain: 'wadyaljuz.com',
      emailDomainId: null,
    });
    mockDomainsCreate.mockResolvedValue({
      data: {
        id: 'd_abc123',
        name: 'wadyaljuz.com',
        status: 'pending',
        records: [
          {
            type: 'TXT',
            name: 'send.wadyaljuz.com',
            value: 'v=spf1 include:amazonses.com ~all',
            ttl: 'Auto',
          },
          {
            type: 'CNAME',
            name: 'resend._domainkey',
            value: 'resend.dkim.amazonses.com',
            ttl: 'Auto',
          },
        ],
      },
      error: null,
    });

    const records = await ResendService.provisionStoreDomain('store-1');

    expect(mockDomainsCreate).toHaveBeenCalledWith({ name: 'wadyaljuz.com' });
    expect(prismaUpdateMock).toHaveBeenCalledWith({
      where: { id: 'store-1' },
      data: { emailDomainId: 'd_abc123', emailDomainStatus: 'pending' },
    });
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ type: 'TXT', name: 'send.wadyaljuz.com' });
  });

  it('is idempotent — if store already has emailDomainId, just refresh and return the records', async () => {
    prismaFindUniqueMock.mockResolvedValue({
      id: 'store-1',
      domain: 'wadyaljuz.com',
      emailDomainId: 'd_existing',
    });
    mockDomainsGet.mockResolvedValue({
      data: {
        id: 'd_existing',
        status: 'verified',
        records: [{ type: 'TXT', name: 'send.wadyaljuz.com', value: '...', ttl: 'Auto' }],
      },
      error: null,
    });

    const records = await ResendService.provisionStoreDomain('store-1');

    expect(mockDomainsCreate).not.toHaveBeenCalled();
    expect(mockDomainsGet).toHaveBeenCalledWith('d_existing');
    expect(records).toHaveLength(1);
  });

  it('throws when store has no custom domain set', async () => {
    prismaFindUniqueMock.mockResolvedValue({
      id: 'store-1',
      domain: null,
      emailDomainId: null,
    });
    await expect(ResendService.provisionStoreDomain('store-1')).rejects.toThrow(
      /no custom domain/i
    );
    expect(mockDomainsCreate).not.toHaveBeenCalled();
  });

  it('throws when Resend returns an error', async () => {
    prismaFindUniqueMock.mockResolvedValue({
      id: 'store-1',
      domain: 'wadyaljuz.com',
      emailDomainId: null,
    });
    mockDomainsCreate.mockResolvedValue({
      data: null,
      error: { name: 'validation_error', message: 'Domain already exists on another account' },
    });
    await expect(ResendService.provisionStoreDomain('store-1')).rejects.toThrow(/already exists/);
  });
});

describe('ResendService.refreshDomainStatus', () => {
  beforeEach(() => vi.clearAllMocks());

  it('fetches latest status and persists verified + verifiedAt', async () => {
    prismaFindUniqueMock.mockResolvedValue({
      id: 'store-1',
      emailDomainId: 'd_abc123',
    });
    mockDomainsGet.mockResolvedValue({
      data: {
        id: 'd_abc123',
        status: 'verified',
        records: [{ type: 'TXT', name: 'send.wadyaljuz.com', value: '...' }],
      },
      error: null,
    });

    const result = await ResendService.refreshDomainStatus('store-1');

    expect(mockDomainsGet).toHaveBeenCalledWith('d_abc123');
    expect(prismaUpdateMock).toHaveBeenCalledWith({
      where: { id: 'store-1' },
      data: { emailDomainStatus: 'verified', emailDomainVerifiedAt: expect.any(Date) },
    });
    expect(result.status).toBe('verified');
    expect(result.records).toHaveLength(1);
  });

  it('persists non-verified status without touching emailDomainVerifiedAt', async () => {
    prismaFindUniqueMock.mockResolvedValue({
      id: 'store-1',
      emailDomainId: 'd_abc123',
    });
    mockDomainsGet.mockResolvedValue({
      data: { id: 'd_abc123', status: 'pending', records: [] },
      error: null,
    });

    await ResendService.refreshDomainStatus('store-1');

    expect(prismaUpdateMock).toHaveBeenCalledWith({
      where: { id: 'store-1' },
      data: { emailDomainStatus: 'pending' },
    });
  });

  it('throws if store has no emailDomainId yet', async () => {
    prismaFindUniqueMock.mockResolvedValue({ id: 'store-1', emailDomainId: null });
    await expect(ResendService.refreshDomainStatus('store-1')).rejects.toThrow(/not provisioned/i);
  });
});

describe('ResendService.removeStoreDomain', () => {
  beforeEach(() => vi.clearAllMocks());

  it('removes the Resend domain and clears all three columns', async () => {
    prismaFindUniqueMock.mockResolvedValue({ id: 'store-1', emailDomainId: 'd_abc123' });
    mockDomainsRemove.mockResolvedValue({ data: { id: 'd_abc123' }, error: null });

    await ResendService.removeStoreDomain('store-1');

    expect(mockDomainsRemove).toHaveBeenCalledWith('d_abc123');
    expect(prismaUpdateMock).toHaveBeenCalledWith({
      where: { id: 'store-1' },
      data: { emailDomainId: null, emailDomainStatus: null, emailDomainVerifiedAt: null },
    });
  });

  it('is a no-op when store has no emailDomainId', async () => {
    prismaFindUniqueMock.mockResolvedValue({ id: 'store-1', emailDomainId: null });
    await ResendService.removeStoreDomain('store-1');
    expect(mockDomainsRemove).not.toHaveBeenCalled();
    expect(prismaUpdateMock).not.toHaveBeenCalled();
  });

  it('clears the columns even if Resend remove returns 404 (already gone)', async () => {
    prismaFindUniqueMock.mockResolvedValue({ id: 'store-1', emailDomainId: 'd_abc123' });
    mockDomainsRemove.mockResolvedValue({
      data: null,
      error: { name: 'not_found', message: 'Domain not found' },
    });

    await ResendService.removeStoreDomain('store-1');

    expect(prismaUpdateMock).toHaveBeenCalledWith({
      where: { id: 'store-1' },
      data: { emailDomainId: null, emailDomainStatus: null, emailDomainVerifiedAt: null },
    });
  });
});

describe('ResendService.sendBrandedEmail', () => {
  beforeEach(() => vi.clearAllMocks());

  it('resolves sender from store, sends via SDK, returns provider id', async () => {
    prismaFindUniqueMock.mockResolvedValue({
      id: 'store-1',
      name: 'Wady Aljuz',
      domain: 'wadyaljuz.com',
      email: 'hi@wadyaljuz.com',
      emailSenderLocalPart: 'noreply',
      emailDomainStatus: 'verified',
    });
    mockEmailsSend.mockResolvedValue({ data: { id: 'em_abc' }, error: null });

    const result = await ResendService.sendBrandedEmail('store-1', {
      to: 'customer@example.com',
      subject: 'Order #123 confirmed',
      html: '<p>thanks</p>',
    });

    expect(mockEmailsSend).toHaveBeenCalledWith({
      from: 'Wady Aljuz <noreply@wadyaljuz.com>',
      to: ['customer@example.com'],
      replyTo: 'hi@wadyaljuz.com',
      subject: 'Order #123 confirmed',
      html: '<p>thanks</p>',
    });
    expect(result).toEqual({ id: 'em_abc' });
  });

  it('falls back to platform domain when store has no verified custom domain', async () => {
    prismaFindUniqueMock.mockResolvedValue({
      id: 'store-1',
      name: 'Palora',
      domain: null,
      email: null,
      emailSenderLocalPart: 'noreply',
      emailDomainStatus: null,
    });
    mockEmailsSend.mockResolvedValue({ data: { id: 'em_xyz' }, error: null });

    await ResendService.sendBrandedEmail('store-1', {
      to: 'customer@example.com',
      subject: 'hi',
      html: '<p>hi</p>',
    });

    expect(mockEmailsSend).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'Palora <noreply@ebda.app>' })
    );
  });

  it('throws when Resend send returns an error', async () => {
    prismaFindUniqueMock.mockResolvedValue({
      id: 'store-1',
      name: 'Palora',
      domain: null,
      email: null,
      emailSenderLocalPart: 'noreply',
      emailDomainStatus: null,
    });
    mockEmailsSend.mockResolvedValue({
      data: null,
      error: { name: 'rate_limit_exceeded', message: 'Slow down' },
    });

    await expect(
      ResendService.sendBrandedEmail('store-1', {
        to: 'a@b.c',
        subject: 's',
        html: '<p>p</p>',
      })
    ).rejects.toThrow(/Slow down/);
  });

  it('throws when store not found', async () => {
    prismaFindUniqueMock.mockResolvedValue(null);
    await expect(
      ResendService.sendBrandedEmail('nope', { to: 'a@b.c', subject: 's', html: '<p>p</p>' })
    ).rejects.toThrow(/Store .* not found/);
  });
});
