/**
 * #1037 — accounting AI calls (reorder/dead-stock scans, expense OCR, profit
 * anomalies, insight narration) must record their usage through the CENTRAL
 * `recordUsage` (ai.service.ts), which stamps `model` + `costMicros`. The old
 * module-local copy wrote neither, so every accounting call was an unpriced
 * row and accounting AI spend was missing from per-store AI cost.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  recordUsage: vi.fn(async () => undefined),
  aiUsageCreate: vi.fn(async () => ({})),
  generateContent: vi.fn(async () => ({
    response: {
      text: () => '{"ok":true}',
      usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 30 },
    },
  })),
}));

vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: class {
    getGenerativeModel() {
      return { generateContent: h.generateContent };
    }
  },
}));
vi.mock('@ebda/database', () => ({ prisma: { aiUsage: { create: h.aiUsageCreate } } }));
vi.mock('@api/lib/ai-quota', () => ({ assertAiQuota: vi.fn(async () => undefined) }));
vi.mock('@api/services/ai.service', () => ({ recordUsage: h.recordUsage }));
vi.mock('@api/lib/logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { callGemini } from '@api/services/accounting/gemini-ai.service';

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GOOGLE_GENERATIVE_AI_KEY = 'test-key';
});

describe('callGemini usage recording (#1037)', () => {
  it('records through the central recordUsage with the model it called', async () => {
    await expect(
      callGemini<{ ok: boolean }>({ prompt: 'p', feature: 'reorder-scan', storeId: 's1' })
    ).resolves.toEqual({ ok: true });

    expect(h.recordUsage).toHaveBeenCalledWith('s1', 'reorder-scan', 120, 30, false, {
      model: process.env.GEMINI_MODEL ?? 'gemini-flash-lite-latest',
    });
    // No second, unpriced row written behind the central writer's back.
    expect(h.aiUsageCreate).not.toHaveBeenCalled();
  });
});
