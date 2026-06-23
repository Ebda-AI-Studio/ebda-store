import { describe, it, expect } from 'vitest';
import { shouldProcessInboxRow, shouldApplyWebhookEffects } from '../webhook-offload.guard';

describe('shouldProcessInboxRow', () => {
  it('false when the inbox row is already processed (retry / duplicate enqueue)', () => {
    expect(shouldProcessInboxRow('processed')).toBe(false);
  });

  it('true for received / processing / failed (work still to do or to retry)', () => {
    expect(shouldProcessInboxRow('received')).toBe(true);
    expect(shouldProcessInboxRow('processing')).toBe(true);
    expect(shouldProcessInboxRow('failed')).toBe(true);
  });
});

describe('shouldApplyWebhookEffects', () => {
  it('true when there is no matching order yet (handleWebhook resolves it)', () => {
    expect(shouldApplyWebhookEffects(null)).toBe(true);
  });

  it('true when the order has not been marked processed', () => {
    expect(shouldApplyWebhookEffects({ webhookProcessedAt: null })).toBe(true);
    expect(shouldApplyWebhookEffects({})).toBe(true);
  });

  it('false when the order is already marked processed — retry short-circuits (no double-apply)', () => {
    expect(shouldApplyWebhookEffects({ webhookProcessedAt: new Date() })).toBe(false);
    expect(shouldApplyWebhookEffects({ webhookProcessedAt: '2026-06-23T00:00:00Z' })).toBe(false);
  });
});
