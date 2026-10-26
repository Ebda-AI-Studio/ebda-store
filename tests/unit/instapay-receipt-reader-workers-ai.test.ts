/**
 * M-003: the receipt reader runs on Cloudflare Workers AI, asks ONLY for amount / reference / date / time (plus its own
 * confidence and looks-edited judgement), and keeps nothing personal from the answer. The AI binding is a fake: what is
 * asserted is the request we send and what we keep, not the model's accuracy (NOT verified here, Ruling M003-1).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const recordUsage = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@api/lib/ai-quota', () => ({ assertAiQuota: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@api/services/ai.service', () => ({ recordUsage }));

import {
  INSTAPAY_RECEIPT_AI_MODEL_DEFAULT,
  INSTAPAY_RECEIPT_JSON_SCHEMA,
  INSTAPAY_RECEIPT_PROMPT,
  normalizeReceiptExtraction,
  readInstapayReceipt,
  unwrapWorkersAiAnswer,
} from '@api/lib/ai/instapay-receipt-reader';
import { clearCfBindings, setCfBindings } from '@api/cf/bindings';

afterEach(() => clearCfBindings());

const ANSWER = {
  amount: 1250.5,
  reference: '241026123456789',
  date: '2026-10-26',
  time: '14:35',
  looksEdited: false,
  confidence: 0.93,
};
const img = Buffer.from('not-really-a-png');

describe('what is asked of the model', () => {
  it('asks for amount, reference, date and time, and tells the model to ignore every person detail', () => {
    for (const k of ['"amount"', '"reference"', '"date"', '"time"'])
      expect(INSTAPAY_RECEIPT_PROMPT).toContain(k);
    // no field for a person: the only mention of names / phones / banks is the instruction NOT to read them
    for (const k of [
      'payerName',
      'payerMobile',
      'payerBank',
      'payerAddress',
      'receiverName',
      'receiverMobile',
      '"note"',
      '"direction"',
    ])
      expect(INSTAPAY_RECEIPT_PROMPT).not.toContain(k);
    expect(INSTAPAY_RECEIPT_PROMPT).toMatch(/Do not read, copy or return any person's name/);
  });

  it('the JSON schema allows exactly six keys, none personal', () => {
    expect(Object.keys(INSTAPAY_RECEIPT_JSON_SCHEMA.properties).sort()).toEqual([
      'amount',
      'confidence',
      'date',
      'looksEdited',
      'reference',
      'time',
    ]);
    expect(INSTAPAY_RECEIPT_JSON_SCHEMA.additionalProperties).toBe(false);
  });

  it('the reader module does not import or mention Gemini / Google at runtime', () => {
    const src = readFileSync(
      path.resolve(__dirname, '../../apps/api/src/lib/ai/instapay-receipt-reader.ts'),
      'utf8'
    );
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/gemini|generativelanguage|googleapis|callGemini/i);
  });
});

describe('what is kept from the answer', () => {
  it('a model that volunteers names, a mobile, a bank and a note has them dropped', () => {
    const e = normalizeReceiptExtraction({
      ...ANSWER,
      payerName: 'Mona Adel',
      payerMobile: '01012345678',
      payerBank: 'CIB',
      payerAddress: 'mona@instapay',
      receiverName: 'Ebda',
      receiverMobile: '0100',
      note: 'rent',
      direction: 'sent',
    });
    expect(e).toMatchObject({
      amountMinor: 125_050,
      reference: '241026123456789',
      transferDate: '2026-10-26',
      transferTime: '14:35',
      confidence: 0.93,
    });
    expect(JSON.stringify(e)).not.toMatch(/Mona|01012345678|CIB|mona@|rent/);
  });
});

describe('the Workers AI call', () => {
  const bind = (run: ReturnType<typeof vi.fn>) => setCfBindings({ AI: { run } } as never);

  it('sends the image as a data URL with the strict prompt + schema to the default vision model, and reads {response}', async () => {
    const run = vi.fn().mockResolvedValue({ response: JSON.stringify(ANSWER) });
    bind(run);
    const e = await readInstapayReceipt({ storeId: 's1', image: img, mimeType: 'image/png' });
    expect(e.amountMinor).toBe(125_050);
    const [model, input] = run.mock.calls[0] as [string, any, any];
    expect(model).toBe(INSTAPAY_RECEIPT_AI_MODEL_DEFAULT);
    const parts = input.messages[0].content;
    expect(parts[0]).toEqual({ type: 'text', text: INSTAPAY_RECEIPT_PROMPT });
    expect(parts[1].image_url.url).toBe(`data:image/png;base64,${img.toString('base64')}`);
    expect(input.guided_json).toBe(INSTAPAY_RECEIPT_JSON_SCHEMA);
    // the read is counted against the store / platform AI caps
    expect(recordUsage).toHaveBeenCalledWith('s1', 'instapay-receipt', 0, 0, false, {
      model: INSTAPAY_RECEIPT_AI_MODEL_DEFAULT,
    });
    expect(input.temperature).toBe(0);
  });

  it('accepts a chat-completion shaped answer and an already-parsed object', () => {
    expect(
      unwrapWorkersAiAnswer({
        choices: [{ message: { content: `Here: ${JSON.stringify(ANSWER)}` } }],
      })
    ).toEqual(ANSWER);
    expect(unwrapWorkersAiAnswer({ response: ANSWER })).toEqual(ANSWER);
    expect(unwrapWorkersAiAnswer({ result: { response: JSON.stringify(ANSWER) } })).toEqual(ANSWER);
    expect(() => unwrapWorkersAiAnswer({ response: 'no json here' })).toThrow(/no JSON/);
    expect(() => unwrapWorkersAiAnswer({ response: '{ not json }' })).toThrow(/malformed/);
  });

  it('without the AI binding the read fails with AI_UNAVAILABLE (the payer types three fields)', async () => {
    await expect(
      readInstapayReceipt({ storeId: 's1', image: img, mimeType: 'image/png' })
    ).rejects.toMatchObject({ code: 'AI_UNAVAILABLE' });
  });

  it('a slow model aborts the call and times out', async () => {
    let aborted = false;
    bind(
      vi.fn(
        (_m: string, _i: unknown, o?: { signal?: AbortSignal }) =>
          new Promise(() => {
            o?.signal?.addEventListener('abort', () => (aborted = true));
          })
      )
    );
    await expect(
      readInstapayReceipt({ storeId: 's1', image: img, mimeType: 'image/png', timeoutMs: 20 })
    ).rejects.toMatchObject({ code: 'AI_TIMEOUT' });
    expect(aborted).toBe(true);
  });

  it('the model can be overridden per deployment', async () => {
    const run = vi.fn().mockResolvedValue({ response: ANSWER });
    setCfBindings({
      AI: { run },
      INSTAPAY_RECEIPT_AI_MODEL: '@cf/meta/llama-3.2-11b-vision-instruct',
    } as never);
    await readInstapayReceipt({ storeId: 's1', image: img, mimeType: 'image/jpeg' });
    expect(run.mock.calls[0][0]).toBe('@cf/meta/llama-3.2-11b-vision-instruct');
  });
});
