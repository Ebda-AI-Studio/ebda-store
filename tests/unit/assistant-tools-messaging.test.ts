/** Messaging + customer-value tools (plan 4 E3): campaigns, newsletter, push, WhatsApp consent, pixels, affiliates, loyalty, wallet. */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  featureEnabled: vi.fn(),
  insertAuditLog: vi.fn(),
  campaign: {
    findCampaignOr404: vi.fn(),
    createCampaignDraft: vi.fn(),
    requestCampaignSend: vi.fn(),
    cancelCampaign: vi.fn(),
    audienceCount: vi.fn(),
    sentInLast24h: vi.fn(),
    storeCampaignDailyCap: vi.fn(),
  },
  nl: { audience: vi.fn(), broadcast: vi.fn() },
  push: { broadcast: vi.fn(), configured: vi.fn() },
  consent: vi.fn(),
  store: { getById: vi.fn(), updatePixels: vi.fn() },
  aff: { getById: vi.fn(), approve: vi.fn(), createPayout: vi.fn() },
  loy: { points: vi.fn(), award: vi.fn(), getSettings: vi.fn(), updateSettings: vi.fn() },
  wallet: { balance: vi.fn(), adjust: vi.fn() },
}));
vi.mock('@api/lib/logger', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@api/lib/definer', () => ({ insertAuditLog: m.insertAuditLog }));
vi.mock('@api/middleware/security', () => ({ auditLog: vi.fn(async () => undefined) }));
vi.mock('@api/services/feature.service', () => ({
  featureService: { isFeatureEnabled: m.featureEnabled },
}));
vi.mock('@api/lib/store-scoped-read', () => ({
  runInStoreTenantContext: async (_s: string, fn: () => unknown) => fn(),
  readInStoreContext: async (_s: string, fn: () => unknown) => fn(),
}));
vi.mock('@api/lib/repo-factory', () => ({ storeDb: vi.fn() }));
vi.mock('@api/services/campaign.service', () => ({
  CAMPAIGN_LIST_SELECT: {},
  CampaignQueueUnreachable: class extends Error {},
  ...m.campaign,
}));
vi.mock('@api/services/newsletter-broadcast.service', () => ({
  BROADCAST_MAX_RECIPIENTS: 400,
  newsletterAudienceSize: m.nl.audience,
  broadcastNewsletter: m.nl.broadcast,
}));
vi.mock('@api/services/onesignal.service', () => ({
  OneSignalNotConfiguredError: class extends Error {},
  OneSignalRequestError: class extends Error {},
  OneSignalService: {
    isConfigured: m.push.configured,
    broadcastToStore: m.push.broadcast,
    listRecentBroadcasts: vi.fn(),
  },
}));
vi.mock('@api/lib/wa/consent', () => ({ WhatsAppConsentService: { record: m.consent } }));
vi.mock('@api/lib/wa/link', () => ({ whatsAppLinkState: vi.fn() }));
vi.mock('@api/services/store.service', () => ({
  StoreService: { getById: m.store.getById, updateMarketingPixels: m.store.updatePixels },
}));
vi.mock('@api/services/affiliate.service', () => ({
  affiliateService: {
    getById: m.aff.getById,
    approve: m.aff.approve,
    reject: vi.fn(),
    suspend: vi.fn(),
    createPayout: m.aff.createPayout,
  },
}));
vi.mock('@api/services/loyalty.service', () => ({
  LoyaltyService: {
    getCustomerPoints: m.loy.points,
    awardBonusPoints: m.loy.award,
    getSettings: m.loy.getSettings,
    updateSettings: m.loy.updateSettings,
  },
}));
vi.mock('@api/services/wallet.service', () => ({
  WALLET_MAX_ENTRY_FILS: 100_000_000,
  WalletService: { getBalance: m.wallet.balance, adminAdjust: m.wallet.adjust },
}));
vi.mock('@api/services/lifecycle-emails.service', () => ({ listLifecycleLog: vi.fn() }));

import { ToolForbidden, effectivePolicy, payloadHash } from '@ebda/shared/smart-layer';
import { messagingTools } from '@api/smart-layer/tools/messaging.tools';
import { applyOf, ctxOf, previewOf, toolNamed } from './helpers/assistant-tool-harness';

const tools = messagingTools();
const T = (n: string) => toolNamed(tools, n);
const cap = { policy: 'confirm', undo: 'unclassified' } as never;

beforeEach(() => {
  vi.clearAllMocks();
  m.featureEnabled.mockResolvedValue(true);
  m.insertAuditLog.mockResolvedValue(undefined);
  m.campaign.audienceCount.mockResolvedValue(120);
  m.campaign.sentInLast24h.mockResolvedValue(0);
  m.campaign.storeCampaignDailyCap.mockResolvedValue(1000);
  m.campaign.createCampaignDraft.mockResolvedValue({ id: 'cmp-new' });
  m.campaign.requestCampaignSend.mockResolvedValue({ status: 'scheduled', audience: 120 });
  m.nl.audience.mockResolvedValue(50);
  m.push.configured.mockReturnValue(true);
  m.store.getById.mockResolvedValue({
    marketingPixels: { meta: { enabled: false, pixelId: '111111', accessToken: 'EAAB-SECRET' } },
  });
  m.aff.getById.mockResolvedValue({
    id: 'af1',
    name: 'Mona',
    status: 'approved',
    pendingBalance: 25050,
    commissionRate: 10,
    updatedAt: new Date(0),
  });
  m.loy.points.mockResolvedValue({ points: 10 });
  m.loy.award.mockResolvedValue({ newBalance: 110 });
  m.loy.getSettings.mockResolvedValue({
    loyaltyEnabled: false,
    settings: { pointsPerMajorUnit: 1, signupBonus: 100 },
  });
  m.wallet.balance.mockResolvedValue(5000);
  m.wallet.adjust.mockResolvedValue({ entry: { id: 'e1' }, balance: 15000, replayed: false });
});

describe('declarations', () => {
  it('every tool has a capability, no store id argument, and customer-facing writes are confirm', () => {
    for (const t of tools) {
      expect(t.capabilityId).toBeTruthy();
      expect(JSON.stringify(t.jsonSchema)).not.toMatch(/store_?id/i);
    }
    const writes = tools.filter(t => t.policy !== 'free');
    for (const t of writes.filter(t => t.name !== 'pixels_set')) expect(t.policy).toBe('confirm');
    for (const n of [
      'campaign_send',
      'campaign_send_draft',
      'newsletter_broadcast',
      'push_broadcast',
    ])
      expect(T(n).messagesCustomers).toBe(true);
  });
});

describe('campaign_send', () => {
  const a = { subject: 'Eid offer', bodyText: 'Ten percent off\n\nuntil Friday' };
  it('shows the audience size and the exact text; the money/message flags give reasons', async () => {
    const d = await previewOf(T('campaign_send'), a);
    expect(d.rows.find(r => r.label.en === 'Audience size')?.after).toBe(120);
    expect(d.rows.find(r => r.label.en === 'Subject')?.after).toBe('Eid offer');
    expect(d.rows.find(r => r.label.en === 'Message text')?.after).toBe(a.bodyText);
    expect(d.affectedCount).toBe(120);
    expect(effectivePolicy(T('campaign_send'), d, { cap }).reasons).toEqual(
      expect.arrayContaining(['customer_message', 'bulk', 'irreversible'])
    );
    expect(T('campaign_send').inverse).toBeUndefined();
  });
  it('editing one character after the card was issued -> payload hash mismatch', async () => {
    const t = T('campaign_send');
    const a2 = { ...a, bodyText: 'Ten percent off\n\nuntil Friday!' };
    const h1 = await payloadHash(t.name, a, await previewOf(t, a));
    const h2 = await payloadHash(t.name, a2, await previewOf(t, a2));
    expect(h1).not.toBe(h2);
  });
  it('a different audience size also changes the hash (re-preview)', async () => {
    const t = T('campaign_send');
    const h1 = await payloadHash(t.name, a, await previewOf(t, a));
    m.campaign.audienceCount.mockResolvedValue(121);
    expect(await payloadHash(t.name, a, await previewOf(t, a))).not.toBe(h1);
  });
  it('saves a draft with escaped paragraphs then sends it; audited as the assistant', async () => {
    await applyOf(T('campaign_send'), { ...a, bodyText: 'a <b>\n\nsecond' });
    expect(m.campaign.createCampaignDraft.mock.calls[0]![1].bodyHtml).toBe(
      '<p>a &lt;b&gt;</p><p>second</p>'
    );
    expect(m.campaign.requestCampaignSend).toHaveBeenCalledWith('s1', 'cmp-new', undefined);
    expect(m.insertAuditLog.mock.calls[0]![0].details.actor).toBe('assistant');
  });
  it('no card for an empty audience, an over-cap send or half a language; staff cannot apply', async () => {
    m.campaign.audienceCount.mockResolvedValue(0);
    await expect(previewOf(T('campaign_send'), a)).rejects.toThrow(/nobody/);
    m.campaign.audienceCount.mockResolvedValue(2000);
    await expect(previewOf(T('campaign_send'), a)).rejects.toThrow(/only 1000/);
    m.campaign.audienceCount.mockResolvedValue(10);
    await expect(previewOf(T('campaign_send'), { subject: 'x' })).rejects.toThrow();
    await expect(applyOf(T('campaign_send'), a, 'staff')).rejects.toBeInstanceOf(ToolForbidden);
    expect(m.campaign.createCampaignDraft).not.toHaveBeenCalled();
  });
});

describe('campaign_send_draft / campaign_cancel', () => {
  const draft = {
    id: 'c1',
    status: 'draft',
    subject: 'Hi',
    subjectAr: null,
    bodyHtml: '<p>x</p>',
    bodyHtmlAr: null,
    updatedAt: new Date(0),
    recipientCount: 0,
    sentCount: 0,
  };
  it('a hand edit of the draft changes the etag; a sent campaign gets no card', async () => {
    m.campaign.findCampaignOr404.mockResolvedValue(draft);
    const d1 = await previewOf(T('campaign_send_draft'), { campaignId: 'c1' });
    expect(d1.rows.find(r => r.label.en === 'Message text')?.after).toBe('<p>x</p>');
    m.campaign.findCampaignOr404.mockResolvedValue({ ...draft, bodyHtml: '<p>y</p>' });
    expect((await previewOf(T('campaign_send_draft'), { campaignId: 'c1' })).etag).not.toBe(
      d1.etag
    );
    m.campaign.findCampaignOr404.mockResolvedValue({ ...draft, status: 'sent' });
    await expect(previewOf(T('campaign_send_draft'), { campaignId: 'c1' })).rejects.toThrow();
  });
  it('a foreign campaign id throws and never reaches run', async () => {
    m.campaign.findCampaignOr404.mockRejectedValue(new Error('not found'));
    await expect(applyOf(T('campaign_send_draft'), { campaignId: 'x' })).rejects.toThrow();
    await expect(applyOf(T('campaign_cancel'), { campaignId: 'x' })).rejects.toThrow();
    expect(m.campaign.requestCampaignSend).not.toHaveBeenCalled();
    expect(m.campaign.cancelCampaign).not.toHaveBeenCalled();
  });
  it('cancel only a scheduled campaign, irreversibly', async () => {
    m.campaign.findCampaignOr404.mockResolvedValue({ ...draft, status: 'scheduled' });
    await applyOf(T('campaign_cancel'), { campaignId: 'c1' });
    expect(m.campaign.cancelCampaign).toHaveBeenCalledWith('s1', 'c1');
    expect(T('campaign_cancel').undo).toBe('irreversible');
    m.campaign.findCampaignOr404.mockResolvedValue(draft);
    await expect(previewOf(T('campaign_cancel'), { campaignId: 'c1' })).rejects.toThrow();
  });
});

describe('newsletter_broadcast and push_broadcast', () => {
  it('newsletter card carries audience + exact text and refuses over 400', async () => {
    const d = await previewOf(T('newsletter_broadcast'), { subject: 'S', message: 'M' });
    expect(d.affectedCount).toBe(50);
    expect(d.rows.find(r => r.label.en === 'Message text')?.after).toBe('M');
    m.nl.audience.mockResolvedValue(401);
    await expect(
      previewOf(T('newsletter_broadcast'), { subject: 'S', message: 'M' })
    ).rejects.toThrow();
  });
  it('newsletter apply passes the text through the service', async () => {
    m.nl.broadcast.mockResolvedValue({ kind: 'sent', sent: 50, total: 50, errors: [] });
    await applyOf(T('newsletter_broadcast'), { subject: 'S', message: 'M', language: 'ar' });
    expect(m.nl.broadcast).toHaveBeenCalledWith('s1', {
      subject: 'S',
      html: '<p>M</p>',
      text: 'M',
      language: 'ar',
    });
  });
  it('push shows all four texts, refuses an http link and an unset provider', async () => {
    const a = { titleEn: 'T', titleAr: 'ع', bodyEn: 'B', bodyAr: 'ن' };
    const d = await previewOf(T('push_broadcast'), a);
    expect(d.rows.find(r => r.label.en === 'Body (Arabic)')?.after).toBe('ن');
    await expect(previewOf(T('push_broadcast'), { ...a, url: 'http://x.y' })).rejects.toThrow();
    m.push.configured.mockReturnValue(false);
    await expect(previewOf(T('push_broadcast'), a)).rejects.toThrow();
  });
});

describe('whatsapp_consent_revoke', () => {
  it('masks the number on the card and revokes through the consent service', async () => {
    m.consent.mockResolvedValue({ granted: false });
    const d = await previewOf(T('whatsapp_consent_revoke'), { phone: '+201012345678' });
    expect(JSON.stringify(d.rows)).not.toContain('01012345678');
    await applyOf(T('whatsapp_consent_revoke'), { phone: '+201012345678' });
    expect(m.consent).toHaveBeenCalledWith('s1', '+201012345678', {
      consent: false,
      source: 'admin',
    });
  });
});

describe('pixels_set', () => {
  it('previews before/after, never exposes the token, rejects token-looking ids', async () => {
    const d = await previewOf(T('pixels_set'), { platform: 'meta', enabled: true, id: '222222' });
    expect(JSON.stringify(d)).not.toContain('EAAB-SECRET');
    expect(d.rows.find(r => r.label.en === 'Enabled')).toMatchObject({
      before: false,
      after: true,
    });
    await expect(
      previewOf(T('pixels_set'), { platform: 'meta', id: 'EAAB1234567' })
    ).rejects.toThrow();
    await expect(
      previewOf(T('pixels_set'), { platform: 'meta', id: 'a'.repeat(41) })
    ).rejects.toThrow();
  });
  it('apply keeps the stored token and undo restores the before values', async () => {
    const t = T('pixels_set');
    const args = { platform: 'meta', enabled: true, id: '222222' };
    const { draft, applied } = await applyOf(t, args);
    expect(m.store.updatePixels).toHaveBeenCalledWith('s1', {
      meta: { enabled: true, pixelId: '222222', accessToken: 'EAAB-SECRET' },
    });
    expect(t.inverse!(ctxOf(), args as never, draft, applied)).toEqual({
      tool: 'pixels_set',
      args: { platform: 'meta', enabled: false, id: '111111' },
    });
    expect(t.policy).toBe('preview');
  });
});

describe('affiliates', () => {
  it('payout amount comes from state, not args; irreversible with no inverse; money reason', async () => {
    const t = T('affiliate_payout');
    const args = { affiliateId: 'af1', amount: 1 } as never; // a model-typed amount is not an argument (strict schema)
    expect(t.args.safeParse(args).success).toBe(false);
    const d = await previewOf(t, { affiliateId: 'af1' });
    expect(d.rows.find(r => r.label.en === 'Amount (EGP)')?.after).toBe('250.5');
    expect(effectivePolicy(t, d, { cap }).reasons).toEqual(
      expect.arrayContaining(['money', 'irreversible'])
    );
    expect(t.inverse).toBeUndefined();
    await applyOf(t, { affiliateId: 'af1', method: 'instapay' });
    expect(m.aff.createPayout.mock.calls[0]![2]).toMatchObject({
      amount: 25050,
      method: 'instapay',
    });
  });
  it('nothing pending -> no card; a foreign id never pays', async () => {
    m.aff.getById.mockResolvedValueOnce({
      id: 'af1',
      name: 'M',
      status: 'approved',
      pendingBalance: 0,
    });
    await expect(previewOf(T('affiliate_payout'), { affiliateId: 'af1' })).rejects.toThrow();
    m.aff.getById.mockRejectedValue(new Error('not found'));
    await expect(applyOf(T('affiliate_payout'), { affiliateId: 'zz' })).rejects.toThrow();
    expect(m.aff.createPayout).not.toHaveBeenCalled();
  });
  it('approve works only on pending', async () => {
    await expect(
      previewOf(T('affiliate_review'), { affiliateId: 'af1', decision: 'approve' })
    ).rejects.toThrow();
    m.aff.getById.mockResolvedValue({ id: 'af1', name: 'M', status: 'pending', pendingBalance: 0 });
    await applyOf(T('affiliate_review'), { affiliateId: 'af1', decision: 'approve' });
    expect(m.aff.approve).toHaveBeenCalledWith('s1', 'af1', 'u1');
  });
});

describe('loyalty', () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `cu${i}`);
  it('loyalty point grant to > 20 customers -> bulk confirm', async () => {
    const t = T('loyalty_award_points');
    const d = await previewOf(t, { customerIds: ids(25), points: 50 });
    expect(d.affectedCount).toBe(25);
    expect(effectivePolicy(t, d, { cap }).reasons).toEqual(
      expect.arrayContaining(['bulk', 'money'])
    );
    const few = await previewOf(t, { customerIds: ids(3), points: 50 });
    expect(effectivePolicy(t, few, { cap }).reasons).not.toContain('bulk');
    expect(t.refs!({ customerIds: ids(2), points: 1 })).toEqual([
      { kind: 'customer', id: 'cu0' },
      { kind: 'customer', id: 'cu1' },
    ]);
  });
  it('awards each customer once through the service; only the owner role', async () => {
    await applyOf(T('loyalty_award_points'), { customerIds: ['a', 'a', 'b'], points: -5 });
    expect(m.loy.award).toHaveBeenCalledTimes(2);
    expect(m.loy.award).toHaveBeenCalledWith('s1', 'a', -5, 'adjust', undefined);
    await expect(
      applyOf(T('loyalty_award_points'), { customerIds: ['a'], points: 5 }, 'staff')
    ).rejects.toBeInstanceOf(ToolForbidden);
  });
  it('settings: only passed keys change; the tool is irreversible like its capability, so it declares no inverse', async () => {
    const t = T('loyalty_settings_set');
    const args = { signupBonus: 300 };
    const { draft, applied } = await applyOf(t, args);
    expect(m.loy.updateSettings).toHaveBeenCalledWith('s1', { settings: { signupBonus: 300 } });
    expect(t.undo).toBe('irreversible');
    expect(t.inverse).toBeUndefined();
    expect(draft.payload).toMatchObject({ restore: { signupBonus: 100 } }); // the before value is still on the card
    void applied;
  });
});

describe('wallet_adjust', () => {
  const args = { customerId: 'cu1', amountEgp: 12.5, note: 'goodwill' };
  it('converts EGP to piasters, shows the before/after balance, money + irreversible', async () => {
    const t = T('wallet_adjust');
    const d = await previewOf(t, args);
    expect(d.rows.find(r => r.label.en === 'Balance (EGP)')).toMatchObject({
      before: '50',
      after: '62.5',
    });
    expect(effectivePolicy(t, d, { cap }).reasons).toEqual(
      expect.arrayContaining(['money', 'irreversible'])
    );
    expect(t.inverse).toBeUndefined();
    await applyOf(t, args);
    expect(m.wallet.adjust.mock.calls[0]![0]).toMatchObject({
      amount: 1250,
      customerId: 'cu1',
      actorId: 'u1',
    });
    expect(t.refs!(args as never)).toEqual([{ kind: 'customer', id: 'cu1' }]);
  });
  it('refuses zero and a debit below the balance', async () => {
    await expect(previewOf(T('wallet_adjust'), { ...args, amountEgp: 0 })).rejects.toThrow();
    await expect(previewOf(T('wallet_adjust'), { ...args, amountEgp: -60 })).rejects.toThrow();
    expect(m.wallet.adjust).not.toHaveBeenCalled();
  });
});

describe('reads', () => {
  it('a read checks the role and the plan feature', async () => {
    const t = T('loyalty_overview');
    await expect(t.read!(ctxOf('staff'), {} as never)).rejects.toThrow();
    m.featureEnabled.mockResolvedValue(false);
    await expect(t.read!(ctxOf(), {} as never)).rejects.toThrow(/feature/);
  });
});
