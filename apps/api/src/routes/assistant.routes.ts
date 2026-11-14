/**
 * The Ebda assistant (Smart Layer, Phase A: read-only "how do I").
 *
 * `/stores/:storeId/assistant/*`: any member of the store (owner or staff; `requireStoreAccess` decides membership), never the shopper API.
 * The model call is slow, so this router is mounted behind `aiRouteContext` (store scope for POST, request transaction for GET; no
 * transaction is held across a model call). `ctx.role` is the caller's own store role, so a tool can only answer what that role may read.
 * `/admin/assistant/*`: the rollout switches, super admin only.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod/v3';
import {
  BUDGET,
  buildSystemPrompt,
  checkAdapterContract,
  computeReleaseId,
  runTurn,
  type TurnCtx,
} from '@ebda/shared/smart-layer';
import { authenticate, authorize } from '../middleware/auth';
import { requireMfaEnrolled } from '../middleware/require-mfa';
import { requireStoreAccess } from '../middleware/store-access';
import { auditLog, writeLimiter } from '../middleware/security';
import { AppError } from '../middleware/error-handler';
import { storeSmartLayer } from '../lib/repo-factory';
import { getAuthUser } from '../utils/store-helpers';
import { StoreService } from '../services/store.service';
import { storeAdapter, type StoreAdapterDeps } from '../smart-layer/adapter';
import { FLAG, readPlatformFlags, setPlatformFlag, storeControls } from '../smart-layer/controls';

const turnBody = z
  .object({
    conversationId: z.string().uuid(),
    text: z.string().min(1).max(BUDGET.inputChars),
    locale: z.enum(['ar', 'en']),
  })
  .strict();
const feedbackBody = z
  .object({ turnId: z.string().uuid(), thumb: z.enum(['up', 'down']) })
  .strict();
const modeBody = z.object({ mode: z.enum(['off', 'answer-only', 'suggest', 'act']) }).strict();
const flagsBody = z
  .object({
    global: z
      .object({
        kill: z.boolean().optional(),
        mode: z.enum(['off', 'answer-only', 'suggest', 'act']).optional(),
        shadow: z.boolean().optional(),
      })
      .strict()
      .optional(),
    product: z.object({ kill: z.boolean() }).strict().optional(),
    killedTools: z.array(z.string().min(1).max(64)).max(100).optional(),
  })
  .strict();

// Once per isolate: the tool list must agree with the capability registry (a weaker policy or a non-live capability fails loud, here and in the tests),
// and the release id (prompt + tools + models + budget) is computed.
/** Test seam (like `configureAgent` in Chat): a scripted model binding, a fake help index, scripted tool reads. Production never sets it. */
let override: Partial<Omit<StoreAdapterDeps, 'storeId'>> = {};
// pq-allow(unused-export): test seam, imported by tests/unit/assistant-route.test.ts and assistant-eval.test.ts
export function configureAssistant(o: typeof override): typeof override {
  const previous = override;
  override = o;
  return previous;
}
/** `<user>:<client id>`: one history per (store, user, conversation). The engine loads turns by conversation id alone, so a client-chosen id can never open (or plant text in) another member's history. */
const ownConversation = (userId: string, conversationId: string): string =>
  `${userId}:${conversationId}`;
/** The kill switch and the rollout mode bind EVERY assistant route, not only the turn: with the assistant off nothing is written to or read from the journal. */
async function assertOn(storeId: string): Promise<void> {
  if ((await storeControls(storeId, override.controls)).mode === 'off')
    throw new AppError(403, 'ASSISTANT_OFF', 'The assistant is not turned on for this store');
}
let contractChecked = false;
let release: Promise<string> | undefined;

export const assistantRoutes = Router({ mergeParams: true });
// Merchant roles only (a shopper's token never reaches this surface), then membership of THIS store.
assistantRoutes.use(
  authenticate,
  authorize('store_admin', 'staff', 'super_admin'),
  requireStoreAccess
);

// Whether the panel should be offered at all: the same decision the turn route makes (a mode other than off after the kill switches, the store's own
// AI switch included). A fail-closed read is simply false.
assistantRoutes.get('/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const c = await storeControls(req.params.storeId!, override.controls);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ success: true, data: { enabled: c.mode !== 'off' } });
  } catch (err) {
    next(err);
  }
});

assistantRoutes.post(
  '/turn',
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = turnBody.parse(req.body);
      const storeId = req.params.storeId!;
      const user = getAuthUser(req);
      // The journal lives on the store's own Durable Object: a store not on its DO has no assistant (503, never a fallback).
      await storeSmartLayer(storeId);
      const adapter = storeAdapter({ storeId, ...override });
      if (!contractChecked) {
        const problems = checkAdapterContract(adapter);
        if (problems.length) throw new Error(`assistant adapter contract: ${problems.join('; ')}`);
        contractChecked = true;
      }
      release ??= computeReleaseId({
        systemPrompt: buildSystemPrompt('ar'),
        tools: adapter.tools(),
        models: adapter.models,
        budget: BUDGET,
      });
      const ctx: TurnCtx = {
        product: 'store',
        storeId,
        userId: user.userId,
        role: user.role,
        locale: body.locale,
        now: Date.now(),
        conversationId: ownConversation(user.userId, body.conversationId),
        releaseId: await release,
      };
      const r = await runTurn(adapter, ctx, { text: body.text });
      res.setHeader('Cache-Control', 'private, no-store');
      res.json({
        success: true,
        data: { status: r.status, segments: r.segments, previews: r.previews, turnId: r.turnId },
      });
    } catch (err) {
      next(err);
    }
  }
);

// Only the caller's own turns: a conversation id is chosen by the client, so it never opens another member's chat.
assistantRoutes.get(
  '/conversations/:conversationId',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = z.string().uuid().parse(req.params.conversationId);
      await assertOn(req.params.storeId!);
      const call = await storeSmartLayer(req.params.storeId!);
      const me = getAuthUser(req).userId;
      const turns = (await call('loadTurns', [
        req.params.storeId,
        ownConversation(me, id),
        40,
      ])) as Array<{
        id: string;
        userId: string;
        role: string;
        maskedText: string;
        at: number;
      }>;
      res.setHeader('Cache-Control', 'private, no-store');
      res.json({
        success: true,
        data: {
          items: turns
            .filter(t => t.userId === me)
            .map(t => ({ id: t.id, role: t.role, text: t.maskedText, at: t.at })),
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

assistantRoutes.post(
  '/feedback',
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = feedbackBody.parse(req.body);
      const storeId = req.params.storeId!;
      const userId = getAuthUser(req).userId;
      await assertOn(storeId);
      const call = await storeSmartLayer(storeId);
      // A person rates a handful of answers a minute; more is a script filling the journal for 90 days.
      if (
        ((await call('bump', [`fbrate:${storeId}:${userId}`, 60_000, Date.now()])) as number) > 30
      )
        throw new AppError(429, 'RATE_LIMITED', 'Too many ratings, try again in a minute');
      // Only an answer THIS person received, once: another member's turn id or an invented one is a plain 404.
      const st = (await call('turnState', [storeId, userId, body.turnId])) as {
        own: boolean;
        rated: boolean;
      };
      if (!st.own) throw new AppError(404, 'NOT_FOUND', 'Turn not found');
      if (!st.rated)
        await call('appendAudit', [
          {
            id: crypto.randomUUID(),
            storeId,
            userId,
            turnId: body.turnId,
            at: Date.now(),
            releaseId: 'feedback',
            maskedPrompt: '',
            maskedOutput: '',
            rails: { thumb: body.thumb },
            toolsOffered: [],
            toolCalls: [],
            outcome: 'answered',
            inputTokens: 0,
            outputTokens: 0,
            model: 'none',
          },
        ]);
      res.json({ success: true, data: { ok: true } });
    } catch (err) {
      next(err);
    }
  }
);

// ---- Rollout switches: super admin only; the platform ones live in D1 so they change without a deploy -------------------------------------
export const assistantAdminRoutes = Router();
// The same chain as every other super-admin router: session, MFA enrolment, role. These switches are the global kill and the rollout stages.
assistantAdminRoutes.use(authenticate, requireMfaEnrolled, authorize('super_admin'));

assistantAdminRoutes.get('/flags', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ success: true, data: await readPlatformFlags() });
  } catch (err) {
    next(err);
  }
});

assistantAdminRoutes.put(
  '/flags',
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const b = flagsBody.parse(req.body);
      if (b.global) await setPlatformFlag(FLAG.global, b.global);
      if (b.product) await setPlatformFlag(FLAG.product, b.product);
      if (b.killedTools) await setPlatformFlag(FLAG.tools, b.killedTools);
      await auditLog({
        action: 'assistant.flags',
        userId: getAuthUser(req).userId,
        resourceType: 'platform',
        resourceId: 'assistant',
        ip: req.ip,
        userAgent: req.get('user-agent'),
        details: b,
      });
      res.json({ success: true, data: await readPlatformFlags() });
    } catch (err) {
      next(err);
    }
  }
);

assistantAdminRoutes.put(
  '/stores/:storeId/mode',
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { mode } = modeBody.parse(req.body);
      const storeId = z.string().uuid().parse(req.params.storeId);
      if (!(await StoreService.getById(storeId)))
        throw new AppError(404, 'STORE_NOT_FOUND', 'Store not found');
      await StoreService.setAssistantMode(storeId, mode);
      await auditLog({
        action: 'assistant.mode',
        userId: getAuthUser(req).userId,
        resourceType: 'store',
        resourceId: storeId,
        storeId,
        ip: req.ip,
        userAgent: req.get('user-agent'),
        details: { mode },
      });
      res.json({ success: true, data: { mode } });
    } catch (err) {
      next(err);
    }
  }
);
