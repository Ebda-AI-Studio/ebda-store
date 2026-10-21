/**
 * WhatsApp template names moved from `force_*` to `ebda_*` (coordinator 2026-10-16), same
 * purpose, same version, same variables. A store whose Meta approval is under the OLD name keeps
 * sending under it until the template is re-submitted and approved under the new one; the new
 * name wins the moment it is approved. Nothing is renamed behind the store's back.
 */
import { prisma, runInTenantContext } from '@ebda/database';
import logger from '../logger';

/** Old canonical name → new canonical name. The ONLY place the old names live. */
export const LEGACY_TEMPLATE_NAMES: Readonly<Record<string, string>> = {
  force_order_paid_v1: 'ebda_order_paid_v1',
  force_order_shipped_v2: 'ebda_order_shipped_v2',
  force_order_delivered_v2: 'ebda_order_delivered_v2',
  force_welcome_back_v1: 'ebda_welcome_back_v1',
  force_cart_abandoned_v1: 'ebda_cart_abandoned_v1',
  force_payment_link_v1: 'ebda_payment_link_v1',
};

/**
 * The name to send under. `approvedNames` = the store's template names currently approved in Meta.
 * Not a legacy name → unchanged. Legacy name → the new name once that is approved, else the legacy
 * name (still the approved one).
 */
export function pickSendTemplateName(configured: string, approvedNames: ReadonlySet<string>) {
  const next = LEGACY_TEMPLATE_NAMES[configured];
  if (!next) return configured;
  return approvedNames.has(next) ? next : configured;
}

/** Store lookup around `pickSendTemplateName`; reads only for a legacy name, never throws. */
export async function resolveSendTemplateName(
  storeId: string,
  configured: string
): Promise<string> {
  const next = LEGACY_TEMPLATE_NAMES[configured];
  if (!next) return configured;
  try {
    const rows = await runInTenantContext(storeId, () =>
      prisma.whatsAppTemplate.findMany({
        where: { storeId, status: 'approved', metaName: next },
        select: { metaName: true },
      })
    );
    return pickSendTemplateName(configured, new Set(rows.map(r => r.metaName)));
  } catch (err) {
    logger.warn({ err, storeId, configured }, '[wa-templates] name lookup failed, keeping name');
    return configured;
  }
}
