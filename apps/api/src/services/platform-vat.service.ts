import { prisma } from '@ebda/database';
import { withPlatformUser } from '../lib/platform-scope';
import {
  DEFAULT_PLATFORM_VAT,
  PLATFORM_VAT_SETTING_KEY,
  platformVatSchema,
  type PlatformVat,
} from '@ebda/shared';
import { auditLog } from '../middleware/security';
import logger from '../lib/logger';
import { parseInput } from '../lib/parse-input';

/**
 * Ebda's OWN VAT on its subscription invoices (ruling TAX-6). Ebda AI Studio
 * is not VAT-registered, so this is OFF by default; a super-admin switches it
 * on from the admin "Platform settings → Ebda VAT" section once registered.
 *
 * Stored as ONE `system_settings` row (`key = 'ebda.vat'`). Read uncached: the
 * value decides money on an invoice (NEVER-stale class) and is read only when a
 * subscription charge is built, so one indexed lookup per charge is the price
 * of never charging under a stale switch.
 *
 * Fail closed: a missing row, or a row that no longer parses, is OFF.
 *
 * Consumers: subscription billing must call `getPlatformVat()` when it builds a
 * charge (see the PR for the exact call sites); while `enabled` is false the
 * charge is the plan price alone and carries no VAT line.
 */
export async function getPlatformVat(): Promise<PlatformVat> {
  const row = await prisma.systemSetting.findUnique({
    where: { key: PLATFORM_VAT_SETTING_KEY },
    select: { value: true },
  });
  if (!row) return { ...DEFAULT_PLATFORM_VAT };
  const parsed = platformVatSchema.safeParse(row.value);
  if (!parsed.success) {
    logger.error(
      { issues: parsed.error.issues },
      '[platform-vat] stored ebda.vat setting is invalid; treating platform VAT as OFF'
    );
    return { ...DEFAULT_PLATFORM_VAT };
  }
  return parsed.data;
}

/**
 * Super-admin write. The route is super_admin-only; the database trigger
 * `platform_vat_setting_guard` independently refuses the write for any caller
 * that is not an active super_admin, so it runs under `withUser(admin)`.
 */
export async function updatePlatformVat(
  input: unknown,
  actor: { userId: string; ip?: string; userAgent?: string }
): Promise<PlatformVat> {
  const next = parseInput(platformVatSchema, input);
  return withPlatformUser(actor.userId, async () => {
    const before = await getPlatformVat();
    await prisma.systemSetting.upsert({
      where: { key: PLATFORM_VAT_SETTING_KEY },
      create: { key: PLATFORM_VAT_SETTING_KEY, value: next, category: 'billing', isPublic: false },
      update: { value: next },
    });
    await auditLog({
      action: 'platform_vat.updated',
      userId: actor.userId,
      resourceType: 'system_setting',
      resourceId: PLATFORM_VAT_SETTING_KEY,
      details: { from: before, to: next },
      ip: actor.ip,
      userAgent: actor.userAgent,
    });
    return next;
  });
}
