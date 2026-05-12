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
