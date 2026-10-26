/**
 * InstaPay receipts + money batch A pure rules (Rulings EBDA-MONEYA-1..6).
 *
 * The AI read is tested against RECORDED Gemini responses: `tests/fixtures/instapay/
 * receipt-{sent,received}.png` are SYNTHETIC receipts (made-up names/numbers, no real
 * PII) drawn in the two real layouts, and `*.gemini.json` is what
 * `gemini-flash-lite-latest` actually answered for them with INSTAPAY_RECEIPT_PROMPT
 * (recorded 2026-10-08). No network call happens here.
 *
 * Mutation proofs (run by hand, recorded in the PR body):
 *   MA-3 period rule: make `manualPeriodFor` always start at `now` -> "early payer" and
 *        "trial payer" go red.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  instapayReceiptFieldsSchema,
  normalizeInstapayReference,
  normalizeInstapayReceiver,
  zonedLocalToUtc,
  type InstapayReceiptFields,
} from '@ebda/shared';
import {
  amountToMinor,
  normalizeReceiptExtraction,
  readInstapayReceipt,
  setReceiptModelCallForTests,
} from '@api/lib/ai/instapay-receipt-reader';
import {
  computeReceiptFlags,
  sniffReceiptMime,
  type FlagInput,
} from '@api/services/payment-providers/instapay-receipt.service';
import { sniffImage } from '@api/lib/upload-sniff';
import { manualPeriodFor } from '@api/services/billing/account.service';
import { ordersOpenFor } from '@api/services/plan-limit.service';

const FIX = path.resolve(__dirname, '../fixtures/instapay');
const recorded = (name: string) =>
  JSON.parse(readFileSync(path.join(FIX, `${name}.gemini.json`), 'utf8')).response as unknown;
const png = (name: string) => readFileSync(path.join(FIX, `${name}.png`));

afterEach(() => setReceiptModelCallForTests(null));

describe('the AI read (recorded answers, two real layouts; personal fields dropped)', () => {
  it('"sent" layout: the payer\'s own receipt', () => {
    const e = normalizeReceiptExtraction(recorded('receipt-sent'));
    expect(e).toMatchObject({
      amountMinor: 123_450,
      reference: '482193377105',
      transferDate: '2026-10-05',
      transferTime: '15:15',
      looksEdited: false,
    });
    // The recorded (old Gemini) answer ALSO carried names, bank, handle and note; the Workers AI reader never asks for
    // them and DROPS them if a model volunteers them (M-003): nothing personal survives normalisation.
    expect(e).toMatchObject({
      payerName: null,
      payerAddress: null,
      payerMobile: null,
      payerBank: null,
      receiverName: null,
      receiverHandle: null,
      receiverMobile: null,
      note: null,
      direction: 'unknown',
    });
    expect(e.confidence).toBeGreaterThan(0.7);
  });

  it('"received" layout: amount, reference and time are read; the masked payer details are NOT kept', () => {
    const e = normalizeReceiptExtraction(recorded('receipt-received'));
    expect(e).toMatchObject({
      amountMinor: 349_000,
      reference: '771034829156',
      transferDate: '2026-10-07',
      transferTime: '21:40',
      payerName: null,
      payerMobile: null,
      payerAddress: null,
      receiverHandle: null,
      direction: 'unknown',
    });
  });

  it('readInstapayReceipt sends the image and normalises the answer', async () => {
    let seen: { mimeType: string; bytes: number } | null = null;
    setReceiptModelCallForTests(async a => {
      seen = { mimeType: a.mimeType, bytes: Buffer.from(a.imageBase64, 'base64').length };
      return recorded('receipt-sent');
    });
    const img = png('receipt-sent');
    const e = await readInstapayReceipt({ storeId: 's', image: img, mimeType: 'image/png' });
    expect(seen).toEqual({ mimeType: 'image/png', bytes: img.length });
    expect(e.reference).toBe('482193377105');
  });

  it('a slow model times out (the caller falls back to manual entry)', async () => {
    setReceiptModelCallForTests(() => new Promise(() => undefined));
    await expect(
      readInstapayReceipt({
        storeId: 's',
        image: png('receipt-sent'),
        mimeType: 'image/png',
        timeoutMs: 20,
      })
    ).rejects.toMatchObject({ code: 'AI_TIMEOUT' });
  });

  it('garbage answers become empty fields with zero confidence, never a throw', () => {
    const e = normalizeReceiptExtraction({
      amount: 'lots',
      reference: 'abc',
      date: 'yesterday',
      confidence: 9,
    });
    expect(e.amountMinor).toBeNull();
    expect(e.transferDate).toBeNull();
    expect(e.confidence).toBe(1);
    expect(normalizeReceiptExtraction('not json').confidence).toBe(0);
  });

  it('reads Arabic digits, separators and 12-hour Arabic times', () => {
    expect(amountToMinor('١٬٢٣٤٫٥٠')).toBe(123_450);
    expect(amountToMinor('1,200')).toBe(120_000);
    const e = normalizeReceiptExtraction({
      date: '05/10/2026',
      time: '3:15 م',
      reference: '٤٨٢١ ٩٣٣٧ ٧١٠٥',
    });
    expect(e.transferDate).toBe('2026-10-05');
    expect(e.transferTime).toBe('15:15');
    expect(e.reference).toBe('482193377105');
  });
});

describe('references, receivers, images, time', () => {
  it('a reference is 8-20 digits (real receipts show 12)', () => {
    expect(normalizeInstapayReference('4821 9337-7105')).toBe('482193377105');
    expect(normalizeInstapayReference('1234567')).toBeNull();
    expect(normalizeInstapayReference('1'.repeat(21))).toBeNull();
    expect(normalizeInstapayReference('IPN-123456789')).toBeNull();
  });
  it("a receiver compares by IPA or by the mobile's last 10 digits", () => {
    expect(normalizeInstapayReceiver('Demo@InstaPay')).toBe('demo@instapay');
    expect(normalizeInstapayReceiver('+20 101 234 5678')).toBe('1012345678');
    expect(normalizeInstapayReceiver('01012345678')).toBe('1012345678');
  });
  it("sniffs the real image type, not the client's word", () => {
    expect(sniffReceiptMime(png('receipt-sent'))).toBe('image/png');
    expect(sniffReceiptMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffReceiptMime(Buffer.from('RIFF0000WEBPVP8 '))).toBe('image/webp');
    expect(sniffReceiptMime(Buffer.from('%PDF-1.7'))).toBeNull();
    expect(sniffReceiptMime(Buffer.from('<svg'))).toBeNull();
  });
  it('one sniffer: receipts reuse sniffImage, minus GIF (FU46 M-8)', () => {
    const samples = [
      png('receipt-sent'),
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.from('RIFF0000WEBPVP8 '),
      Buffer.from('GIF89a......'),
      Buffer.from('GIF87a......'),
      Buffer.from('%PDF-1.7'),
      Buffer.alloc(0),
    ];
    for (const b of samples) {
      const kind = sniffImage(b);
      expect(sniffReceiptMime(b)).toBe(kind === 'image/gif' ? null : kind);
    }
    // no second copy of the magic bytes in the receipt service
    const src = readFileSync(
      path.resolve(
        __dirname,
        '../../apps/api/src/services/payment-providers/instapay-receipt.service.ts'
      ),
      'utf8'
    );
    expect(src).not.toMatch(/0xff|0x89|'RIFF'|'WEBP'/);
  });
  it("converts the receipt's Cairo wall-clock time to UTC (DST-aware)", () => {
    // 5 Oct 2026: Egypt summer time (UTC+3).
    expect(zonedLocalToUtc('2026-10-05', '15:15', 'Africa/Cairo')!.toISOString()).toBe(
      '2026-10-05T12:15:00.000Z'
    );
    // 15 Jan 2026: winter (UTC+2).
    expect(zonedLocalToUtc('2026-01-15', '00:30', 'Africa/Cairo')!.toISOString()).toBe(
      '2026-01-14T22:30:00.000Z'
    );
    expect(zonedLocalToUtc('2026-02-30', '10:00', 'Africa/Cairo')).toBeUndefined();
  });
  it('the payer form schema rejects a non-digit reference and an unknown key', () => {
    const ok: InstapayReceiptFields = instapayReceiptFieldsSchema.parse({
      amountMinor: 123_450,
      reference: '482193377105',
      transferDate: '2026-10-05',
      transferTime: '15:15',
      payerName: 'SYN*** T***',
    });
    expect(ok.payerAddress).toBeNull();
    expect(() => instapayReceiptFieldsSchema.parse({ ...ok, reference: 'ABCDEFGHIJ' })).toThrow();
    expect(() => instapayReceiptFieldsSchema.parse({ ...ok, status: 'approved' })).toThrow();
  });
});

describe('automatic checks flag, they never block', () => {
  const now = new Date('2026-10-08T10:00:00Z');
  const base = (): FlagInput => ({
    fields: {
      amountMinor: 123_450,
      reference: '482193377105',
      transferDate: '2026-10-05',
      transferTime: '15:15',
      payerName: 'SYNTH TEST PAYER',
      payerAddress: 'synthpayer@instapay',
      payerMobile: null,
      payerBank: 'CIB',
      receiverName: 'DEMO STORE LLC',
      receiverHandle: 'demostore@instapay',
      receiverMobile: null,
      note: null,
    },
    transferredAt: new Date('2026-10-05T12:15:00Z'),
    extraction: normalizeReceiptExtraction(recorded('receipt-sent')),
    extractionStatus: 'done',
    expectedAmountMinor: 123_450,
    expectedReceivers: ['demostore@instapay', '01012345678'],
    notBefore: new Date('2026-10-05T12:00:00Z'),
    notBeforeFlag: 'DATE_BEFORE_ORDER',
    sameImageSeenBefore: false,
    now,
  });
  it('a clean receipt has no flags', () => {
    expect(computeReceiptFlags(base())).toEqual([]);
  });
  it('RECEIVER-CHECK-1: the model says the receiver is NOT the expected account -> RECEIVER_MISMATCH, even when the payer typed the right one', () => {
    const b = base();
    const f = computeReceiptFlags({ ...b, extraction: { ...b.extraction!, receiverMatch: false } });
    expect(f).toContain('RECEIVER_MISMATCH');
  });
  it('RECEIVER-CHECK-1: the model confirms the receiver -> no receiver flag even if the payer left it blank', () => {
    const b = base();
    const f = computeReceiptFlags({
      ...b,
      fields: { ...b.fields, receiverHandle: null, receiverMobile: null },
      extraction: { ...b.extraction!, receiverMatch: true },
    });
    expect(f).not.toContain('RECEIVER_MISSING');
    expect(f).not.toContain('RECEIVER_MISMATCH');
  });
  it('RECEIVER-CHECK-1: the payer TYPED a wrong receiver and the model says yes -> still RECEIVER_MISMATCH (a model yes never hides a typed mismatch)', () => {
    const b = base();
    const f = computeReceiptFlags({
      ...b,
      fields: { ...b.fields, receiverHandle: 'someone-else@instapay', receiverMobile: null },
      extraction: { ...b.extraction!, receiverMatch: true },
    });
    expect(f).toContain('RECEIVER_MISMATCH');
  });
  it('RECEIVER-CHECK-1: no expected receiver configured -> no MISMATCH flag from the model (null), typed check unchanged', () => {
    const b = base();
    const f = computeReceiptFlags({
      ...b,
      expectedReceivers: [],
      extraction: { ...b.extraction!, receiverMatch: null },
    });
    expect(f).not.toContain('RECEIVER_MISMATCH');
  });
  it('RECEIVER-CHECK-1: the AI failed -> AI_UNAVAILABLE and the typed check as today (manual review, nothing auto-approved)', () => {
    const b = base();
    const f = computeReceiptFlags({
      ...b,
      extraction: null,
      extractionStatus: 'failed',
      expectedReceivers: ['other@instapay'],
    });
    expect(f).toContain('AI_UNAVAILABLE');
    expect(f).toContain('RECEIVER_MISMATCH'); // the payer-typed comparison still runs
  });
  it('each check raises its own flag', () => {
    const b = base();
    expect(computeReceiptFlags({ ...b, expectedAmountMinor: 100_000 })).toContain(
      'AMOUNT_MISMATCH'
    );
    expect(computeReceiptFlags({ ...b, expectedReceivers: ['other@instapay'] })).toContain(
      'RECEIVER_MISMATCH'
    );
    expect(
      computeReceiptFlags({
        ...b,
        fields: { ...b.fields, receiverHandle: null, receiverMobile: null },
      })
    ).toContain('RECEIVER_MISSING');
    expect(computeReceiptFlags({ ...b, notBefore: new Date('2026-10-06T00:00:00Z') })).toContain(
      'DATE_BEFORE_ORDER'
    );
    expect(
      computeReceiptFlags({ ...b, transferredAt: new Date('2026-10-09T00:00:00Z') })
    ).toContain('DATE_IN_FUTURE');
    expect(
      computeReceiptFlags({ ...b, extraction: { ...b.extraction!, confidence: 0.4 } })
    ).toContain('LOW_CONFIDENCE');
    expect(
      computeReceiptFlags({ ...b, extraction: { ...b.extraction!, looksEdited: true } })
    ).toContain('LOOKS_EDITED');
    expect(computeReceiptFlags({ ...b, fields: { ...b.fields, amountMinor: 200_000 } })).toEqual(
      expect.arrayContaining(['FIELDS_CORRECTED', 'AMOUNT_MISMATCH'])
    );
    expect(computeReceiptFlags({ ...b, sameImageSeenBefore: true })).toContain(
      'SAME_IMAGE_USED_BEFORE'
    );
    expect(computeReceiptFlags({ ...b, extraction: null, extractionStatus: 'failed' })).toEqual([
      'AI_UNAVAILABLE',
    ]);
  });
  it('a receiver matches by mobile too', () => {
    const b = base();
    expect(
      computeReceiptFlags({
        ...b,
        fields: { ...b.fields, receiverHandle: null, receiverMobile: '+201012345678' },
      })
    ).toEqual([]);
  });
});

describe('period rule: a manual payment never burns paid days (audit M2)', () => {
  const now = new Date('2026-10-08T10:00:00Z');
  it('early payer: starts at the current period end', () => {
    const end = new Date('2026-10-15T10:00:00Z');
    const p = manualPeriodFor(
      { status: 'active', trialEndsAt: null, currentPeriodEnd: end },
      'monthly',
      now
    );
    expect(p.periodStart).toEqual(end);
    expect(p.periodEnd.toISOString()).toBe('2026-11-15T10:00:00.000Z');
  });
  it('trial payer: starts at the trial end', () => {
    const trialEnd = new Date('2026-10-19T10:00:00Z');
    const p = manualPeriodFor(
      { status: 'trialing', trialEndsAt: trialEnd, currentPeriodEnd: null },
      'yearly',
      now
    );
    expect(p.periodStart).toEqual(trialEnd);
    expect(p.periodEnd.toISOString()).toBe('2027-10-19T10:00:00.000Z');
  });
  it('late payer, canceled store, or no subscription: starts now', () => {
    const past = new Date('2026-10-01T10:00:00Z');
    expect(
      manualPeriodFor(
        { status: 'past_due', trialEndsAt: null, currentPeriodEnd: past },
        'monthly',
        now
      ).periodStart
    ).toEqual(now);
    expect(
      manualPeriodFor(
        { status: 'canceled', trialEndsAt: null, currentPeriodEnd: new Date('2026-12-01') },
        'monthly',
        now
      ).periodStart
    ).toEqual(now);
    expect(manualPeriodFor(null, 'monthly', now).periodStart).toEqual(now);
  });
});

describe('orders at trial end are decided at order time (audit #3)', () => {
  const now = new Date('2026-10-08T10:00:00Z');
  const ended = new Date('2026-10-08T09:00:00Z');
  it('a trial that just ended keeps taking orders when a card or InstaPay is set', () => {
    expect(
      ordersOpenFor(
        { status: 'trialing', trialEndsAt: ended, billingMethod: 'instapay', hasSavedCard: false },
        now
      )
    ).toBe(true);
    expect(
      ordersOpenFor(
        { status: 'trialing', trialEndsAt: ended, billingMethod: 'card', hasSavedCard: true },
        now
      )
    ).toBe(true);
  });
  it('no payment method at trial end, or a canceled subscription, closes orders', () => {
    expect(
      ordersOpenFor(
        { status: 'trialing', trialEndsAt: ended, billingMethod: null, hasSavedCard: false },
        now
      )
    ).toBe(false);
    expect(
      ordersOpenFor(
        { status: 'canceled', trialEndsAt: null, billingMethod: 'instapay', hasSavedCard: false },
        now
      )
    ).toBe(false);
  });
  it('a running trial and paid states are open', () => {
    expect(
      ordersOpenFor(
        {
          status: 'trialing',
          trialEndsAt: new Date('2026-10-20'),
          billingMethod: null,
          hasSavedCard: false,
        },
        now
      )
    ).toBe(true);
    expect(
      ordersOpenFor(
        { status: 'past_due', trialEndsAt: null, billingMethod: 'instapay', hasSavedCard: false },
        now
      )
    ).toBe(true);
  });
});
