import type { FeatureKey } from '@ebda/shared';
import { featureService } from '../services/feature.service';
import { auditLog } from '../middleware/security';
import { hasPermission, type Permission, type Role } from '../middleware/rbac';
import { insertAuditLog } from '../lib/definer';
import { runInStoreTenantContext } from '../lib/store-scoped-read';
import logger from '../lib/logger';

/**
 * ONE gate chain for an AI actor that does what a merchant could do (Ahmad, 2026-11-14 action boundary; plan 4 Task B5, ruling SL-STORE-2).
 * The Merchant MCP write tools (merchant-write.ts) and the Ebda assistant tools both pass through these functions, so the two paths cannot
 * drift: the same RBAC, the same plan gate, the same fail-closed audit intent, the same tenant context.
 *
 *  1. A platform super admin never acts through here (ORDER-MONEY-SUPERADMIN). So there is no MFA state to re-check at call time: the only
 *     role MFA is enforced for is refused first, and owner/staff MFA is opt-in at login, not per permission.
 *  2. The acting user's own role must hold the SAME `Permission` (or role list) the admin route demands, plus the route's `requireFeature` key.
 *  3. An `intent` audit row is written BEFORE the change through the append-only definer; if it fails, the change is refused.
 *     A `completed` / `failed` row follows (best effort: the change already happened).
 *  4. The change runs inside the store's tenant context.
 */

type MerchantActor = 'mcp' | 'assistant';

/** The refusal every gate raises. The message keeps the `FORBIDDEN:` prefix the MCP SDK turns into an error result; the assistant maps the class to `ToolForbidden`. */
// pq-allow(unused-export): imported by the assistant tool kit (smart-layer/tools/kit.ts, next PR of the stack) and tests/unit/run-as-merchant.test.ts
export class MerchantForbidden extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MerchantForbidden';
  }
}

/** The audit row's own shape plus who asked. */
type MerchantAuditSpec = {
  action: string;
  resourceType: string;
  resourceId?: string;
};

// pq-allow(unused-export): imported by the assistant tool kit (smart-layer/tools/kit.ts, next PR of the stack) and tests/unit/run-as-merchant.test.ts
export interface MerchantGate {
  storeId: string;
  userId: string;
  role: Role | string;
  tool: string;
  permission?: Permission;
  /** For routes guarded by `authorize(...roles)` instead of a permission. */
  roles?: readonly Role[];
  feature?: FeatureKey;
}

/** RBAC of the acting user + the route's feature gate. Throws `MerchantForbidden`. */
export async function assertMerchantMay(g: MerchantGate): Promise<void> {
  if (g.role === 'super_admin') {
    throw new MerchantForbidden(
      `FORBIDDEN: ${g.tool}: MCP write tools are not available to platform super-admin keys.`
    );
  }
  if (g.permission && !hasPermission(g.role as Role, g.permission)) {
    throw new MerchantForbidden(
      `FORBIDDEN: ${g.tool} needs the "${g.permission}" permission; the key's owner (${g.role}) lacks it.`
    );
  }
  if (g.roles && !g.roles.includes(g.role as Role)) {
    throw new MerchantForbidden(
      `FORBIDDEN: ${g.tool} is limited to ${g.roles.join(' / ')}; the key's owner is ${g.role}.`
    );
  }
  if (g.feature && !(await featureService.isFeatureEnabled(g.storeId, g.feature))) {
    throw new MerchantForbidden(
      `FORBIDDEN: ${g.tool} needs the "${g.feature}" feature, which is not enabled for this store.`
    );
  }
}

interface MerchantAuditCtx {
  storeId: string;
  userId: string;
  tool: string;
  actor: MerchantActor;
  audit: MerchantAuditSpec;
  details?: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
  /** Extra fields stamped into `details` (the MCP key id). */
  stamp?: Record<string, unknown>;
}

/** One audit row. `strict` rows (the intent) throw on failure so the caller refuses the write; the rest only log. */
export async function writeMerchantAudit(
  c: MerchantAuditCtx,
  phase: 'intent' | 'completed' | 'failed',
  extra?: Record<string, unknown>,
  strict = false
): Promise<void> {
  const entry = {
    action: c.audit.action,
    userId: c.userId,
    storeId: c.storeId,
    resourceType: c.audit.resourceType,
    resourceId: c.audit.resourceId,
    ip: c.ip,
    userAgent: c.userAgent,
    details: {
      ...(c.details ?? {}),
      ...extra,
      phase,
      tool: c.tool,
      actor: c.actor,
      ...(c.stamp ?? {}),
    },
  };
  if (strict) {
    await insertAuditLog(entry);
    return;
  }
  await auditLog(entry).catch(err =>
    logger.error({ err, action: c.audit.action, phase }, '[merchant write] post-write audit failed')
  );
}

interface RunAsMerchantOptions extends MerchantGate, Omit<MerchantAuditCtx, 'stamp'> {
  actor: MerchantActor;
}

/** Gate + intent audit + tenant context + completed/failed audit around `fn`. `fn` MUST call the same service the admin route calls. */
// pq-allow(unused-export): imported by the assistant tool kit (smart-layer/tools/kit.ts, next PR of the stack) and tests/unit/run-as-merchant.test.ts
export async function runAsMerchant<T>(o: RunAsMerchantOptions, fn: () => Promise<T>): Promise<T> {
  await assertMerchantMay(o);
  try {
    await writeMerchantAudit(o, 'intent', undefined, true);
  } catch (err) {
    logger.error({ err, tool: o.tool }, '[merchant write] intent audit failed; write refused');
    throw new Error(
      `UNAVAILABLE: ${o.tool} was NOT performed because the audit log could not be written. Retry.`
    );
  }
  let result: T;
  try {
    result = await runInStoreTenantContext(o.storeId, fn, o.userId);
  } catch (err) {
    await writeMerchantAudit(o, 'failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
  await writeMerchantAudit(o, 'completed');
  return result;
}
