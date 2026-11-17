/**
 * Catalogue field sweep routes — Unit Tests
 *
 * Covers the 4 new bulk-sweep routes (category, image-alt, excerpt, tags):
 * each creates a BulkAiJob with the right `kind`, sends the matching
 * Inngest event, and marks the job failed (+ 503) when the enqueue itself
 * throws. Handlers are pulled directly off the Express Router's route
 * stack so the test doesn't need to boot the app or its auth middleware.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../apps/api/src/lib/logger', () => ({
  default: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const mockBulkAiJobCreate = vi.fn();
const mockBulkAiJobUpdate = vi.fn();
vi.mock('@ebda/database', () => ({
  prisma: {
    bulkAiJob: {
      create: (...args: unknown[]) => mockBulkAiJobCreate(...args),
      update: (...args: unknown[]) => mockBulkAiJobUpdate(...args),
    },
  },
  // withSavepoint (lib/savepoint.ts) asks this; no request transaction here.
  hasTenantContext: () => false,
  currentStoreId: () => 'store-1',
}));

const mockInngestSend = vi.fn();
vi.mock('../../apps/api/src/lib/inngest/client', () => ({
  inngest: { send: (...args: unknown[]) => mockInngestSend(...args) },
}));

vi.mock('../../apps/api/src/middleware/auth', () => ({
  authenticate: (_req: unknown, _res: unknown, next: () => void) => next(),
  authorize: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../apps/api/src/middleware/store-access', () => ({
  requireStoreAccess: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../apps/api/src/middleware/security', () => ({
  writeLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../apps/api/src/middleware/feature-gate', () => ({
  requireFeature: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../apps/api/src/services/ai.service', () => ({
  AIService: {},
}));
vi.mock('../../apps/api/src/services/ai-autofill.service', () => ({
  fillProductFields: vi.fn(),
  balanceProductLanguages: vi.fn(),
  revertProductBalance: vi.fn(),
}));
vi.mock('../../apps/api/src/lib/ai/product-faq-generator', () => ({
  generateProductFaqs: vi.fn(),
}));

import aiRoutes from '../../apps/api/src/routes/ai.routes';

// -- Helpers -----------------------------------------------------------

interface RouteLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{ handle: (...args: unknown[]) => unknown }>;
  };
}

function getHandler(method: 'post' | 'get', path: string) {
  const layers = (aiRoutes as unknown as { stack: RouteLayer[] }).stack;
  const layer = layers.find(l => l.route?.path === path && l.route.methods[method]);
  if (!layer?.route) throw new Error(`Route ${method.toUpperCase()} ${path} not found`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle as (
    req: unknown,
    res: unknown,
    next: (err?: unknown) => void
  ) => Promise<void>;
}

function mockReqRes(body: object = {}) {
  const req = {
    params: { storeId: 'store-1' },
    body,
    user: { userId: 'user-1' },
  };
  const jsonMock = vi.fn();
  const statusMock = vi.fn(() => ({ json: jsonMock }));
  const res = { status: statusMock, json: jsonMock };
  const next = vi.fn();
  return { req, res, next, jsonMock, statusMock };
}

beforeEach(() => {
  mockBulkAiJobCreate.mockReset();
  mockBulkAiJobUpdate.mockReset();
  mockInngestSend.mockReset();
  mockBulkAiJobCreate.mockResolvedValue({
    id: 'job-1',
    status: 'queued',
    kind: 'category_assign',
    createdAt: new Date(),
  });
  mockInngestSend.mockResolvedValue({ ids: ['evt-1'] });
});

describe.each([
  { path: '/bulk/categorize', kind: 'category_assign', event: 'bulk-ai/categorize-requested' },
  { path: '/bulk/image-alt', kind: 'image_alt', event: 'bulk-ai/image-alt-requested' },
  { path: '/bulk/excerpt', kind: 'excerpt', event: 'bulk-ai/excerpt-requested' },
  { path: '/bulk/tags', kind: 'product_tags', event: 'bulk-ai/tags-requested' },
])('POST $path', ({ path, kind, event }) => {
  it('creates a BulkAiJob with the right kind and sends the matching Inngest event', async () => {
    mockBulkAiJobCreate.mockResolvedValue({
      id: 'job-1',
      status: 'queued',
      kind,
      createdAt: new Date(),
    });

    const handler = getHandler('post', path);
    const { req, res, next, jsonMock, statusMock } = mockReqRes({});

    await handler(req, res, next);

    expect(mockBulkAiJobCreate).toHaveBeenCalledTimes(1);
    const createArgs = mockBulkAiJobCreate.mock.calls[0][0];
    expect(createArgs.data.kind).toBe(kind);
    expect(createArgs.data.storeId).toBe('store-1');

    expect(mockInngestSend).toHaveBeenCalledTimes(1);
    const sendArgs = mockInngestSend.mock.calls[0][0];
    expect(sendArgs.name).toBe(event);
    expect(sendArgs.data.jobId).toBe('job-1');
    expect(sendArgs.data.storeId).toBe('store-1');

    expect(statusMock).toHaveBeenCalledWith(202);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: { job: expect.objectContaining({ id: 'job-1' }) },
      })
    );
  });

  // categorize and image-alt never replace merchant content (NEVER-OVERWRITE-1): see the dedicated block below
  const honoursForce = path === '/bulk/excerpt' || path === '/bulk/tags';
  it.runIf(honoursForce)(
    'passes force=true through to the Inngest event when requested',
    async () => {
      const handler = getHandler('post', path);
      const { req, res, next } = mockReqRes({ force: true });

      await handler(req, res, next);

      const sendArgs = mockInngestSend.mock.calls[0][0];
      expect(sendArgs.data.force).toBe(true);
    }
  );

  it('marks the job failed and returns 503 when the Inngest enqueue throws', async () => {
    mockInngestSend.mockRejectedValueOnce(new Error('enqueue boom'));

    const handler = getHandler('post', path);
    const { req, res, next, jsonMock, statusMock } = mockReqRes({});

    await handler(req, res, next);

    expect(mockBulkAiJobUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'job-1', storeId: 'store-1' },
        data: expect.objectContaining({ status: 'failed' }),
      })
    );
    expect(statusMock).toHaveBeenCalledWith(503);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({ code: 'AI_QUEUE_UNREACHABLE' }),
      })
    );
  });
});

describe.each([
  { path: '/bulk/categorize', kind: 'category_assign' },
  { path: '/bulk/image-alt', kind: 'image_alt' },
])('POST $path ignores force (NEVER-OVERWRITE-1, Ruling RF-833-2)', ({ path, kind }) => {
  it('a direct API call with force=true does not reach the job row or the event', async () => {
    mockBulkAiJobCreate.mockResolvedValue({
      id: 'job-1',
      status: 'queued',
      kind,
      createdAt: new Date(),
    });
    const handler = getHandler('post', path);
    const { req, res, next } = mockReqRes({ force: true });

    await handler(req, res, next);

    expect(mockBulkAiJobCreate.mock.calls[0][0].data).not.toHaveProperty('force');
    expect(mockInngestSend.mock.calls[0][0].data).not.toHaveProperty('force');
  });
});
