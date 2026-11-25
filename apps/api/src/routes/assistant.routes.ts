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
  applyPreview,
  buildSystemPrompt,
  checkAdapterContract,
  computeReleaseId,
  confirmApproval,
  issueApproval,
  rejectApproval,
  runTurn,
  undoApplied,
  UNDO_WINDOW_MS,
  type ApprovalToken,
  type PreviewCard,
  type SmartLayerAdapter,
  type TurnCtx,
} from '@ebda/shared/smart-layer';
import { authenticate, authorize, rejectImpersonated } from '../middleware/auth';
import { requireMfaEnrolled } from '../middleware/require-mfa';
import { readAuditByResource } from '../lib/audit-read';
import { requireStoreAccess } from '../middleware/store-access';
import { auditLog, writeLimiter } from '../middleware/security';
import { AppError } from '../middleware/error-handler';
import { storeSmartLayer } from '../lib/repo-factory';
import { MerchantForbidden } from '../mcp/run-as-merchant';
import { gateOf } from '../smart-layer/tools/kit';
import { getAuthUser } from '../utils/store-helpers';
import { StoreService } from '../services/store.service';
import { storeAdapter, type StoreAdapterDeps } from '../smart-layer/adapter';
import {
  FLAG,
  assistantState,
  readPlatformFlags,
  setPlatformFlag,
  storeControls,
} from '../smart-layer/controls';

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

/** Builds the adapter + the turn context for ONE request: the membership-checked store, the caller's own id and store role, the release id. */
async function engineFor(
  req: Request,
  locale: 'ar' | 'en',
  conversationId: string
): Promise<{ adapter: SmartLayerAdapter; ctx: TurnCtx }> {
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
  return {
    adapter,
    ctx: {
      product: 'store',
      storeId,
      userId: user.userId,
      role: user.role,
      locale,
      now: Date.now(),
      conversationId,
      releaseId: await release,
    },
  };
}
/** The approval ids and one-time tokens of confirm cards, handed to the browser OUT OF BAND: never inside a card, a turn row, an audit row or a model request. */
const approvalsOut = (t: ApprovalToken[]) =>
  t.map(({ approvalId, token }) => ({ approvalId, token }));
/** A re-preview card that now needs the merchant's explicit confirmation gets its approval here (the engine issues it for turns, not for a stale re-preview). */
async function approvalForCard(
  adapter: SmartLayerAdapter,
  ctx: TurnCtx,
  card: PreviewCard,
  tokens: ApprovalToken[]
): Promise<PreviewCard> {
  if (card.policy !== 'confirm' || card.approvalId) return card;
  const rec = await adapter.storage.getPreview(ctx.storeId, card.previewId);
  if (!rec) return card;
  const issued = await issueApproval(adapter, ctx, rec);
  tokens.push({ approvalId: issued.approvalId, previewId: rec.id, token: issued.token });
  return { ...card, approvalId: issued.approvalId };
}
const ACTION_HTTP: Record<string, [number, string]> = {
  mode: [409, 'ASSISTANT_MODE'],
  killed: [409, 'ASSISTANT_OFF'],
  forbidden: [403, 'FORBIDDEN'],
  failed: [502, 'APPLY_FAILED'],
  not_found: [404, 'NOT_FOUND'],
  expired: [410, 'EXPIRED'],
  needs_confirm: [409, 'NEEDS_CONFIRM'],
  irreversible: [409, 'IRREVERSIBLE'],
  used: [409, 'APPROVAL_USED'],
  mismatch: [409, 'APPROVAL_MISMATCH'],
  missing: [404, 'NOT_FOUND'],
  not_pending: [409, 'NOT_PENDING'],
};
const actionError = (status: string): AppError => {
  const [code, name] = ACTION_HTTP[status] ?? [500, 'ACTION_FAILED'];
  return new AppError(code, name, `The assistant action ended: ${status}`);
};
const actionBody = z.object({ locale: z.enum(['ar', 'en']).default('ar') }).strict();

export const assistantRoutes = Router({ mergeParams: true });
// Merchant roles only (a shopper's token never reaches this surface), then membership of THIS store.
// An impersonated (support "act as merchant") session is refused on EVERY assistant route, exactly like the admin routes it stands in for (ruling FP-3):
// the impersonation token carries the merchant's role, so the super-admin refusal in `assertMerchantMay` never fires for it, and the assistant can
// otherwise confirm refunds, plan changes, deletions and customer messages on the merchant's behalf. Looking is allowed on the admin screens; the assistant
// is a way to ACT, so it is closed to those sessions entirely (status included: the panel simply does not appear).
assistantRoutes.use(
  authenticate,
  rejectImpersonated,
  authorize('store_admin', 'staff', 'super_admin'),
  requireStoreAccess
);

// Whether the panel should be offered at all: the same decision the turn route makes (a mode other than off after the kill switches, the store's own
// AI switch included). A fail-closed read is simply false.
assistantRoutes.get('/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const st = await assistantState(req.params.storeId!, override.controls);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      success: true,
      data: { enabled: st.enabled, mode: st.controls.mode, reason: st.reason },
    });
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
      const { adapter, ctx } = await engineFor(
        req,
        body.locale,
        ownConversation(getAuthUser(req).userId, body.conversationId)
      );
      const approvals: ApprovalToken[] = [];
      const r = await runTurn(
        adapter,
        ctx,
        { text: body.text },
        { onApprovalToken: t => approvals.push(t) }
      );
      res.setHeader('Cache-Control', 'private, no-store');
      res.json({
        success: true,
        data: {
          status: r.status,
          segments: r.segments,
          previews: r.previews,
          turnId: r.turnId,
          approvals: approvalsOut(approvals),
        },
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

// Apply a preview card: the engine re-reads the controls, re-previews and checks the etag, then applies (a changed etag returns the NEW card instead).
// Confirm-class cards never apply here: they need the approval route (C2).
assistantRoutes.post(
  '/previews/:previewId/apply',
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const previewId = z.string().uuid().parse(req.params.previewId);
      const { locale } = actionBody.parse(req.body ?? {});
      const storeId = req.params.storeId!;
      await assertOn(storeId);
      const { adapter, ctx } = await engineFor(
        req,
        locale,
        ownConversation(getAuthUser(req).userId, 'action')
      );
      const out = await applyPreview(adapter, ctx, previewId);
      res.setHeader('Cache-Control', 'private, no-store');
      if (out.status === 'applied')
        return void res.json({
          success: true,
          data: { status: 'applied', appliedId: out.appliedId, undoUntil: out.undoUntil },
        });
      if (out.status === 'stale') {
        const tokens: ApprovalToken[] = [];
        const card = await approvalForCard(adapter, ctx, out.card, tokens);
        return void res.json({
          success: true,
          data: { status: 'stale', card, approvals: approvalsOut(tokens) },
        });
      }
      throw actionError(out.status);
    } catch (err) {
      next(err);
    }
  }
);

// Undo what the assistant applied (24 h). Changed since (the merchant edited it by hand) -> the card of what undo WOULD do, nothing written.
assistantRoutes.post(
  '/applied/:appliedId/undo',
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const appliedId = z.string().uuid().parse(req.params.appliedId);
      const { locale } = actionBody.parse(req.body ?? {});
      const storeId = req.params.storeId!;
      await assertOn(storeId);
      const { adapter, ctx } = await engineFor(
        req,
        locale,
        ownConversation(getAuthUser(req).userId, 'action')
      );
      const tokens: ApprovalToken[] = [];
      const out = await undoApplied(adapter, ctx, appliedId, {
        onApprovalToken: t => tokens.push(t),
      });
      res.setHeader('Cache-Control', 'private, no-store');
      if (out.status === 'undone')
        return void res.json({ success: true, data: { status: 'undone' } });
      if (out.status === 'stale' || out.status === 'needs_confirm')
        return void res.json({
          success: true,
          data: {
            status: out.status,
            card: await approvalForCard(adapter, ctx, out.card, tokens),
            approvals: approvalsOut(tokens),
          },
        });
      throw actionError(out.status);
    } catch (err) {
      next(err);
    }
  }
);

const confirmBody = z
  .object({ token: z.string().min(20).max(200), locale: z.enum(['ar', 'en']).default('ar') })
  .strict();
const rejectBody = z
  .object({ reason: z.string().max(200).optional(), locale: z.enum(['ar', 'en']).default('ar') })
  .strict();

// The ONLY door a confirm-class change goes through: the merchant presses the button in the UI and it calls this route with the one-time token it was
// handed out of band. No tool, no model text and no typed "yes" can reach it. Single use, bound to the exact previewed payload, 15 minutes.
assistantRoutes.post(
  '/approvals/:approvalId/confirm',
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const approvalId = z.string().uuid().parse(req.params.approvalId);
      const body = confirmBody.parse(req.body);
      const storeId = req.params.storeId!;
      await assertOn(storeId);
      const { adapter, ctx } = await engineFor(
        req,
        body.locale,
        ownConversation(getAuthUser(req).userId, 'action')
      );
      // Re-check the merchant's own permission NOW (a role can change between the card and the press): a refusal burns the approval and is logged.
      const appr = await adapter.storage.getApproval(storeId, approvalId);
      const pv = appr ? await adapter.storage.getPreview(storeId, appr.previewId) : null;
      const tool = pv ? adapter.tools().find(t => t.name === pv.tool) : undefined;
      const gate = tool ? gateOf(tool) : undefined;
      if (appr && pv && gate && appr.userId === ctx.userId) {
        try {
          await gate(ctx);
        } catch (err) {
          if (!(err instanceof MerchantForbidden)) throw err;
          await adapter.storage.closeApproval(storeId, approvalId, 'rejected');
          await adapter.storage.recordDecision({
            approvalId,
            storeId,
            decider: ctx.userId,
            decision: 'rejected:permission',
            reason: 'role no longer allows this change',
            at: ctx.now,
          });
          throw actionError('forbidden');
        }
      }
      const tokens: ApprovalToken[] = [];
      const out = await confirmApproval(adapter, ctx, approvalId, body.token, {
        onApprovalToken: t => tokens.push(t),
      });
      res.setHeader('Cache-Control', 'private, no-store');
      if (out.status === 'applied')
        return void res.json({
          success: true,
          data: {
            status: 'applied',
            appliedId: out.appliedId,
            undoUntil: ctx.now + UNDO_WINDOW_MS,
          },
        });
      if (out.status === 'stale')
        return void res.json({
          success: true,
          data: { status: 'stale', card: out.card, approvals: approvalsOut(tokens) },
        });
      throw out.status === 'expired' ? actionError('expired') : actionError(out.status);
    } catch (err) {
      next(err);
    }
  }
);

assistantRoutes.post(
  '/approvals/:approvalId/reject',
  writeLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const approvalId = z.string().uuid().parse(req.params.approvalId);
      const body = rejectBody.parse(req.body ?? {});
      await assertOn(req.params.storeId!);
      const { adapter, ctx } = await engineFor(
        req,
        body.locale,
        ownConversation(getAuthUser(req).userId, 'action')
      );
      const out = await rejectApproval(adapter, ctx, approvalId, body.reason);
      if (out.status !== 'rejected')
        throw actionError(
          out.status === 'missing'
            ? 'missing'
            : out.status === 'forbidden'
              ? 'forbidden'
              : 'not_pending'
        );
      res.setHeader('Cache-Control', 'private, no-store');
      res.json({ success: true, data: { status: 'rejected' } });
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

/** One store's rollout mode + who last changed it (from the `assistant.mode` audit rows), so the super-admin control can show the trail. */
assistantAdminRoutes.get(
  '/stores/:storeId/mode',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const storeId = z.string().uuid().parse(req.params.storeId);
      const store = await StoreService.getById(storeId);
      if (!store) throw new AppError(404, 'STORE_NOT_FOUND', 'Store not found');
      const raw = ((store.settings ?? {}) as Record<string, unknown>).assistantMode;
      const mode = modeBody.shape.mode.safeParse(raw).success ? (raw as string) : 'off';
      const last = (await readAuditByResource(storeId, 'store', storeId, 50)).find(
        r => r.action === 'assistant.mode'
      );
      const by = last?.user
        ? [last.user.firstName, last.user.lastName].filter(Boolean).join(' ')
        : '';
      res.setHeader('Cache-Control', 'private, no-store');
      // QA-112: `mode` is the flag the super admin set; `effective` is what the merchant actually gets (same source as /status).
      const st = await assistantState(storeId, override.controls);
      res.json({
        success: true,
        data: {
          mode,
          effective: { mode: st.controls.mode, reason: st.reason },
          lastChange: last ? { by: by || null, at: last.createdAt } : null,
        },
      });
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
