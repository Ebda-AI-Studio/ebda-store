import { z, type ZodRawShape } from 'zod/v3';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { withStore } from '@ebda/database';
import { runInStoreTenantContext } from '../lib/store-scoped-read';
import type { FeatureKey } from '@ebda/shared';
import { featureService } from '../services/feature.service';
import type { Permission, Role } from '../middleware/rbac';
import { AppError } from '../middleware/error-handler';
import logger from '../lib/logger';
import {
  MERCHANT_SCOPES,
  assertScope,
  type MerchantAuth,
  type MerchantScope,
} from './merchant-auth';
import {
  signConfirmToken,
  verifyConfirmToken,
  consumeConfirmToken,
  hashConfirmArgs,
  CONFIRM_TOKEN_TTL_MS,
} from './merchant-confirm-token';
import type { McpStore } from './resolve-store';
import { assertMerchantMay, writeMerchantAudit } from './run-as-merchant';
import { ok } from './tools/tool-result';

/**
 * Shared infrastructure every merchant-MCP WRITE tool goes through (Ahmad,
 * 2026-10-10, binding decision 4). ONE place for the cross-cutting concerns so
 * a new write tool cannot forget one of them — a tool is declared with
 * `registerMerchantWriteTool` and never touches scope/confirm/audit itself:
 *
 *  1. Store scope. Each tool runs inside ONE store's closure
 *     (`buildMerchantMcpServer(store)`). Defence in depth: the verified key's
 *     `auth.storeId` must equal that store (else `FORBIDDEN`, the 403 case),
 *     every service call runs inside `runInTenantContext(store.id)`, and a
 *     store-scoped service's 404 (an id that belongs to another store, or to
 *     none) is surfaced as the SAME `FORBIDDEN: ... not found in this store`
 *     for both — no cross-store existence oracle.
 *  2. Plan + switch. The `merchant_mcp_write` feature (plan: Growth + Business,
 *     Feature-Matrix override wins) AND the merchant's own
 *     `store.settings.mcpWriteEnabled` (absent = on) must both allow the write.
 *  3. RBAC. The key acts AS its owning user: the same `Permission`/role the
 *     admin route demands of that user is demanded here (staff cannot delete
 *     products over MCP any more than in the dashboard), plus the same
 *     `requireFeature` key the route carries (coupons, inventory, returns).
 *  4. Destructive confirm round-trip: first call returns a token + a human
 *     summary of exactly what would happen; the second call with the token
 *     executes. Token = HMAC over tool + store + key + actor + canonical args
 *     + expiry + nonce, and is SINGLE-USE (merchant-confirm-token.ts).
 *  5. Audit, fail closed. An `intent` row (actor=mcp) is written BEFORE the
 *     mutation through the append-only definer, and its failure REFUSES the
 *     write. A `completed`/`failed` row follows (best-effort: the mutation
 *     already happened, so a failure there is logged, not thrown).
 *  6. Rate limit: `ADMIN_WRITE_TOOL_NAMES` (admin-write.tools.ts) feeds the
 *     write limiter in routes/mcp-admin.routes.ts.
 */

/** The FeatureKey gating writes, layered UNDER `merchant_mcp`. */
export const MERCHANT_MCP_WRITE_FEATURE = 'merchant_mcp_write' as const;

/** Seconds until a freshly minted confirm token expires. */
export const CONFIRM_TOKEN_TTL_SECONDS = CONFIRM_TOKEN_TTL_MS / 1000;

/**
 * Plan/feature half + merchant-switch half of the write gate. Throws the same
 * `FORBIDDEN:`-prefixed plain Error `assertScope` uses (the SDK turns a thrown
 * Error into `{ isError: true }`).
 */
export async function assertMerchantWriteEnabled(storeId: string, tool: string): Promise<void> {
  const enabled = await featureService.isFeatureEnabled(storeId, MERCHANT_MCP_WRITE_FEATURE);
  if (!enabled) {
    throw new Error(
      `FORBIDDEN: ${tool} is not available on this store's plan (MCP write tools need Growth or ` +
        'Business) or was switched off by the platform.'
    );
  }
  // NEVER-stale read (a permission switch): straight from the DB, no cache layer.
  const row = await withStore(storeId, tx =>
    tx.store.findUnique({ where: { id: storeId }, select: { settings: true } })
  );
  const settings = (row?.settings ?? {}) as Record<string, unknown>;
  if (settings.mcpWriteEnabled === false) {
    throw new Error(
      `FORBIDDEN: ${tool} is disabled for this store. The store owner turned MCP write tools off ` +
        '(Settings > Integrations > Merchant MCP).'
    );
  }
}

/** 404 from a store-scoped service => FORBIDDEN (no existence oracle). Other errors pass through. */
export function mapStoreScopeError(err: unknown, tool: string): never {
  if (err instanceof AppError && err.statusCode === 404) {
    throw new Error(
      `FORBIDDEN: ${tool}: the target was not found in this store (it does not exist, or belongs to another store).`
    );
  }
  throw err;
}

export interface WriteToolContext {
  store: McpStore;
  auth: MerchantAuth;
  /** Run `fn` inside this store's tenant context (RLS GUCs set). */
  inStore: <T>(fn: () => Promise<T>) => Promise<T>;
}

export interface WriteToolSpec<S extends ZodRawShape> {
  name: string;
  description: string;
  /** Tool input (a zod RAW SHAPE). For destructive tools `confirmToken` is added. */
  input: S;
  /** Delete / refund / cancel / bulk: requires the confirm round-trip. */
  destructive?: boolean;
  /** RBAC permission the owning user must hold — the SAME one the admin route uses. */
  permission?: Permission;
  /** Alternative to `permission` for routes guarded by `authorize(...roles)`. */
  roles?: readonly Role[];
  /** Extra extension check for a role-dependent argument (e.g. gateway refund). */
  extraAuthorize?: (args: any, auth: MerchantAuth) => void;
  /** The `requireFeature(...)` key the equivalent admin route carries. */
  feature?: FeatureKey;
  audit: {
    action: string;
    resourceType: string;
    resourceId?: (args: any, result?: any) => string | undefined;
    details?: (args: any, result?: any) => Record<string, unknown>;
  };
  /**
   * Destructive only. Resolves the target INSIDE the store scope (so a foreign
   * id throws before any token is minted) and returns the human summary shown
   * with the confirm token.
   */
  summarize?: (args: any, ctx: WriteToolContext) => Promise<string>;
  /** The mutation. MUST call the same service method the admin route calls. */
  run: (args: any, ctx: WriteToolContext) => Promise<Record<string, unknown>>;
}

/** Mints the token a destructive tool returns on its first call. */
function mintConfirmToken(
  store: McpStore,
  auth: MerchantAuth,
  tool: string,
  argsHash: string
): string {
  return signConfirmToken({
    tool,
    storeId: store.id,
    keyId: auth.keyId,
    userId: auth.userId,
    argsHash,
  });
}

async function auditPhase(
  spec: WriteToolSpec<ZodRawShape>,
  ctx: WriteToolContext,
  args: any,
  phase: 'intent' | 'completed' | 'failed',
  result?: any,
  extra?: Record<string, unknown>,
  strict = false
): Promise<void> {
  await writeMerchantAudit(
    {
      storeId: ctx.store.id,
      userId: ctx.auth.userId,
      tool: spec.name,
      actor: 'mcp',
      audit: {
        action: spec.audit.action,
        resourceType: spec.audit.resourceType,
        resourceId: spec.audit.resourceId?.(args, result),
      },
      details: spec.audit.details?.(args, result),
      ip: ctx.auth.ip,
      userAgent: ctx.auth.userAgent,
      stamp: { keyId: ctx.auth.keyId },
    },
    phase,
    extra,
    strict
  );
}

/**
 * Registers one merchant-MCP write tool with the full gate chain above.
 */
export function registerMerchantWriteTool<S extends ZodRawShape>(
  server: McpServer,
  store: McpStore,
  spec: WriteToolSpec<S>
): void {
  const inputSchema: ZodRawShape = spec.destructive
    ? {
        ...spec.input,
        confirmToken: z
          .string()
          .optional()
          .describe(
            'Token returned by the first call to this tool with the SAME arguments. Omit on the first call.'
          ),
      }
    : spec.input;
  const scope: MerchantScope = spec.destructive
    ? MERCHANT_SCOPES.destructive
    : MERCHANT_SCOPES.write;

  server.registerTool(
    spec.name,
    { description: spec.description, inputSchema },
    async (rawArgs: any, extra: any) => {
      const { confirmToken, ...args } = rawArgs as Record<string, unknown> & {
        confirmToken?: string;
      };

      // 1. Scope, then store match (the 403 case), then plan + switch.
      const auth = assertScope(extra?.authInfo, scope, spec.name);
      if (auth.storeId !== store.id) {
        logger.warn(
          { tool: spec.name, keyStoreId: auth.storeId, storeId: store.id },
          '[mcp write] key/store mismatch refused'
        );
        throw new Error(`FORBIDDEN: ${spec.name}: this key does not belong to this store.`);
      }
      await assertMerchantWriteEnabled(store.id, spec.name);

      // 2. RBAC of the owning user + the route's feature gate (shared with the assistant: run-as-merchant.ts). A platform
      //    super_admin never runs a store's own workflow (ORDER-MONEY-SUPERADMIN), so its keys are refused there.
      await assertMerchantMay({
        storeId: store.id,
        userId: auth.userId,
        role: auth.role,
        tool: spec.name,
        permission: spec.permission,
        roles: spec.roles,
        feature: spec.feature,
      });
      spec.extraAuthorize?.(args, auth);

      const ctx: WriteToolContext = {
        store,
        auth,
        inStore: fn => runInStoreTenantContext(store.id, fn),
      };

      // 3. Destructive: confirm round-trip.
      if (spec.destructive) {
        let summary: string;
        try {
          summary = spec.summarize ? await spec.summarize(args, ctx) : spec.description;
        } catch (err) {
          mapStoreScopeError(err, spec.name);
        }
        const argsHash = hashConfirmArgs(args);
        const confirmed =
          !!confirmToken &&
          verifyConfirmToken(confirmToken, {
            tool: spec.name,
            storeId: store.id,
            keyId: auth.keyId,
            userId: auth.userId,
            argsHash,
          });
        if (!confirmed) {
          return ok({
            confirmationRequired: true,
            confirmToken: mintConfirmToken(store, auth, spec.name, argsHash),
            expiresInSeconds: CONFIRM_TOKEN_TTL_SECONDS,
            summary,
            message:
              `NOTHING WAS CHANGED. Show the summary to the merchant; if they agree, call ${spec.name} ` +
              'again with the SAME arguments plus this confirmToken (single use).',
          });
        }
      }

      // 4. Fail-closed audit: no audit row, no write.
      try {
        await auditPhase(spec, ctx, args, 'intent', undefined, undefined, true);
      } catch (err) {
        logger.error({ err, tool: spec.name }, '[mcp write] intent audit failed; write refused');
        throw new Error(
          `UNAVAILABLE: ${spec.name} was NOT performed because the audit log could not be written. Retry.`
        );
      }

      // 5. Destructive: burn the token (single-use) before acting.
      if (spec.destructive) {
        const first = await consumeConfirmToken(confirmToken!);
        if (!first) {
          await auditPhase(spec, ctx, args, 'failed', undefined, {
            reason: 'confirm_token_replayed',
          });
          throw new Error(
            `FORBIDDEN: ${spec.name}: this confirmToken was already used. Call the tool again without a token to get a new one.`
          );
        }
      }

      // 6. The mutation — the SAME service call the admin route makes.
      let result: Record<string, unknown>;
      try {
        result = await spec.run(args, ctx);
      } catch (err) {
        await auditPhase(spec, ctx, args, 'failed', undefined, {
          error: err instanceof Error ? err.message : String(err),
        });
        mapStoreScopeError(err, spec.name);
      }
      await auditPhase(spec, ctx, args, 'completed', result);
      return ok(result);
    }
  );
}
