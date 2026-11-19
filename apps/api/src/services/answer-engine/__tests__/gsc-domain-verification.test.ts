import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  ensureGscDomainProperty,
  extractMetaToken,
  type GscVerificationDeps,
} from '../gsc-domain-verification.service';

const TOKEN = 'fake-verification-token-for-tests';

function deps(over: Partial<GscVerificationDeps> = {}) {
  const d = {
    listSites: vi.fn(async () => ['sc-domain:ebda.app']),
    getToken: vi.fn(async () => TOKEN),
    verify: vi.fn(async () => true),
    addSite: vi.fn(async () => true),
    readStore: vi.fn(async () => ({ domain: 'www.AmeliaAurum.com', googleSiteVerification: null })),
    publishToken: vi.fn(async () => {}),
    ...over,
  };
  return d;
}

describe('extractMetaToken', () => {
  it('reads content out of the meta snippet Google returns', () => {
    expect(extractMetaToken(`<meta name="google-site-verification" content="${TOKEN}" />`)).toBe(
      TOKEN
    );
    expect(extractMetaToken('<meta content="short">')).toBeNull();
    expect(extractMetaToken(undefined)).toBeNull();
  });
});

describe('ensureGscDomainProperty', () => {
  it('publishes the token, verifies and adds the apex URL-prefix property', async () => {
    const d = deps();
    expect(await ensureGscDomainProperty('s1', d)).toBe('verified');
    expect(d.getToken).toHaveBeenCalledWith('https://ameliaaurum.com/');
    expect(d.publishToken).toHaveBeenCalledWith('s1', TOKEN);
    expect(d.verify).toHaveBeenCalledWith('https://ameliaaurum.com/');
    expect(d.addSite).toHaveBeenCalledWith('https://ameliaaurum.com/');
  });

  it('is a no-op when an exact property is already accessible (idempotent)', async () => {
    const d = deps({ listSites: vi.fn(async () => ['https://ameliaaurum.com/']) });
    expect(await ensureGscDomainProperty('s1', d)).toBe('already_connected');
    expect(d.getToken).not.toHaveBeenCalled();
    expect(d.verify).not.toHaveBeenCalled();
  });

  it('does not re-publish a token that is already ours, and still verifies', async () => {
    const d = deps({
      readStore: vi.fn(async () => ({ domain: 'ameliaaurum.com', googleSiteVerification: TOKEN })),
    });
    expect(await ensureGscDomainProperty('s1', d)).toBe('verified');
    expect(d.publishToken).not.toHaveBeenCalled();
  });

  it("never overwrites a merchant's own token", async () => {
    const d = deps({
      readStore: vi.fn(async () => ({
        domain: 'ameliaaurum.com',
        googleSiteVerification: 'merchant-own-token-for-tests',
      })),
    });
    expect(await ensureGscDomainProperty('s1', d)).toBe('merchant_token');
    expect(d.publishToken).not.toHaveBeenCalled();
    expect(d.verify).not.toHaveBeenCalled();
  });

  it('fails soft: a verify that Google rejects returns a status, skips sites.add', async () => {
    const d = deps({ verify: vi.fn(async () => false) });
    expect(await ensureGscDomainProperty('s1', d)).toBe('verify_failed');
    expect(d.addSite).not.toHaveBeenCalled();
  });

  it('reports token_failed / sites_add_failed / no_domain', async () => {
    expect(await ensureGscDomainProperty('s1', deps({ getToken: vi.fn(async () => null) }))).toBe(
      'token_failed'
    );
    expect(await ensureGscDomainProperty('s1', deps({ addSite: vi.fn(async () => false) }))).toBe(
      'sites_add_failed'
    );
    expect(
      await ensureGscDomainProperty(
        's1',
        deps({ readStore: vi.fn(async () => ({ domain: null, googleSiteVerification: null })) })
      )
    ).toBe('no_domain');
  });
});
