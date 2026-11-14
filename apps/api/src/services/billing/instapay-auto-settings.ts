/**
 * InstaPay auto-confirm switches (Ruling INSTAPAY-AUTO-1): the global mode (`off` | `shadow` | `live`, default `off`) and the per-store
 * switch. Both live in `system_settings` (D1 in production) and are changed by a super-admin or by a "not received" revert, with no deploy.
 *
 * Staleness class: NEVER-stale (a money switch). Every read goes to the database on every decision; there is deliberately NO cache here, so
 * no invalidation exists to forget. Fail CLOSED: a missing, unreadable or unparsable row is `off` / "store disabled" for the decision.
 */
import { prisma } from '@ebda/database';
import { AppError } from '../../middleware/error-handler';
import { auditLog } from '../../middleware/security';
import logger from '../../lib/logger';

export type AutoMode = 'off' | 'shadow' | 'live';
export const AUTO_MODE_KEY = 'instapay.auto_confirm.mode';
export const STORE_SWITCH_PREFIX = 'instapay.auto_confirm.store.';
const MODES: readonly AutoMode[] = ['off', 'shadow', 'live'];

export const storeSwitchKey = (storeId: string) => `${STORE_SWITCH_PREFIX}${storeId}`;

export async function getAutoMode(): Promise<AutoMode> {
  const row = await prisma.systemSetting.findUnique({
    where: { key: AUTO_MODE_KEY },
    select: { value: true },
  });
  if (!row) return 'off';
  const m = (row.value as { mode?: unknown } | null)?.mode;
  if (typeof m === 'string' && (MODES as readonly string[]).includes(m)) return m as AutoMode;
  logger.error({ value: row.value }, '[instapay-auto] stored mode is invalid; treating it as off');
  return 'off';
}

/** Unreadable / unparsable per-store row counts as DISABLED (fail closed); no row = enabled. */
export async function isStoreAutoEnabled(storeId: string): Promise<boolean> {
  const row = await prisma.systemSetting.findUnique({
    where: { key: storeSwitchKey(storeId) },
    select: { value: true },
  });
  if (!row) return true;
  const v = row.value as { disabled?: unknown } | null;
  if (v && v.disabled === false) return true;
  return false;
}

const reasonOk = (r: string) => typeof r === 'string' && r.trim().length >= 5;

export async function setAutoMode(
  mode: AutoMode,
  actorId: string,
  reason: string
): Promise<AutoMode> {
  if (!(MODES as readonly string[]).includes(mode))
    throw new AppError(400, 'INVALID_MODE', 'The mode must be off, shadow or live');
  if (!reasonOk(reason)) throw new AppError(400, 'REASON_REQUIRED', 'Write why (5+ characters)');
  const before = await getAutoMode();
  const value = {
    mode,
    by: actorId,
    reason: reason.trim().slice(0, 300),
    at: new Date().toISOString(),
  };
  await prisma.systemSetting.upsert({
    where: { key: AUTO_MODE_KEY },
    create: { key: AUTO_MODE_KEY, value, category: 'billing', isPublic: false },
    update: { value },
  });
  await auditLog({
    action: 'billing.instapay_auto_mode_changed',
    userId: actorId,
    resourceType: 'system_setting',
    resourceId: AUTO_MODE_KEY,
    details: { from: before, to: mode, reason: value.reason },
  });
  return mode;
}

export async function setStoreAuto(
  storeId: string,
  enabled: boolean,
  actorId: string,
  reason: string
): Promise<boolean> {
  if (!reasonOk(reason)) throw new AppError(400, 'REASON_REQUIRED', 'Write why (5+ characters)');
  const before = await isStoreAutoEnabled(storeId);
  const value = {
    disabled: !enabled,
    by: actorId,
    reason: reason.trim().slice(0, 300),
    at: new Date().toISOString(),
  };
  await prisma.systemSetting.upsert({
    where: { key: storeSwitchKey(storeId) },
    create: { key: storeSwitchKey(storeId), value, category: 'billing', isPublic: false },
    update: { value },
  });
  await auditLog({
    action: 'billing.instapay_auto_store_toggled',
    userId: actorId.startsWith('system:') || actorId.startsWith('telegram') ? undefined : actorId,
    storeId,
    resourceType: 'system_setting',
    resourceId: storeSwitchKey(storeId),
    details: { from: before, to: enabled, reason: value.reason, actor: actorId },
  });
  return enabled;
}

/** Stores a super-admin (or a revert) switched off, newest first; for the admin screen. */
export async function listDisabledStores(): Promise<
  Array<{ storeId: string; reason: string | null; at: string | null }>
> {
  const rows = await prisma.systemSetting.findMany({
    where: { key: { startsWith: STORE_SWITCH_PREFIX } },
    select: { key: true, value: true },
    take: 500,
  });
  return rows
    .map(r => ({ r, v: (r.value ?? {}) as { disabled?: boolean; reason?: string; at?: string } }))
    .filter(x => x.v.disabled !== false)
    .map(x => ({
      storeId: x.r.key.slice(STORE_SWITCH_PREFIX.length),
      reason: x.v.reason ?? null,
      at: x.v.at ?? null,
    }));
}
