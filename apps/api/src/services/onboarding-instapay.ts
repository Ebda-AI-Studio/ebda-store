/**
 * InstaPay during self-serve onboarding (audit FIX-006).
 *
 * InstaPay is a MANUAL method (no merchant API): the customer transfers to the
 * merchant's handle/phone and the merchant confirms receipt. Onboarding used to
 * send only `{ cod }`, so a new store could not enable it until it found
 * Settings > Payments. This writes the SAME `payment_configs` row that the
 * admin payment-settings page writes (provider `instapay`, non-secret settings
 * validated by the same shared schema), so the two surfaces cannot drift.
 *
 * Kept out of `onboarding.service.ts` on purpose: it only needs prisma and the
 * shared schema, and the route calls it before `setPaymentMethods` so the
 * "at least one method stays on" rule sees the new state.
 */
import { storeDb, storeWriter } from '../lib/repo-factory';
import { prisma, type Prisma } from '@ebda/database';
import { instapaySettingsSchema } from '@ebda/shared';
import { AppError } from '../middleware/error-handler';
import { PaymentService } from './payment.service';

export interface OnboardingInstapayInput {
  enabled: boolean;
  handle?: string;
  phone?: string;
  accountName?: string;
}

export async function applyOnboardingInstapay(
  storeId: string,
  input: OnboardingInstapayInput
): Promise<{ instapay: boolean; configId: string | null }> {
  const existing = await (
    await storeDb(storeId)
  ).paymentConfig.findFirst({
    where: { storeId, provider: 'instapay' },
    select: { id: true, settings: true },
  });

  if (!input.enabled) {
    if (existing) {
      await (
        await storeWriter(storeId)
      ).paymentConfig.update({
        where: { id: existing.id, storeId },
        data: { isEnabled: false },
      });
      PaymentService.clearCache(storeId);
    }
    return { instapay: false, configId: existing?.id ?? null };
  }

  // Enabling needs a handle or a phone: same rule as the admin page and checkout.
  // Blank strings from an untouched form field count as absent.
  const parsed = instapaySettingsSchema.safeParse({
    ...((existing?.settings as Record<string, unknown> | null) ?? {}),
    ...Object.fromEntries(
      Object.entries({
        handle: input.handle,
        phone: input.phone,
        accountName: input.accountName,
      }).filter(([, v]) => v !== undefined && v !== '')
    ),
  });
  if (!parsed.success) {
    throw new AppError(
      422,
      'INVALID_PAYMENT_SETTINGS',
      parsed.error.issues.map(i => `${i.path.join('.') || 'settings'}: ${i.message}`).join('; ')
    );
  }
  const settings = parsed.data as Prisma.InputJsonValue;

  const config = existing
    ? await (
        await storeWriter(storeId)
      ).paymentConfig.update({
        where: { id: existing.id, storeId },
        data: { isEnabled: true, settings },
        select: { id: true },
      })
    : await (
        await storeWriter(storeId)
      ).paymentConfig.create({
        data: {
          storeId,
          provider: 'instapay',
          isEnabled: true,
          displayName: 'InstaPay',
          displayNameAr: 'إنستاباي',
          testMode: false,
          supportedMethods: ['instapay'],
          supportedCurrencies: ['EGP'],
          fixedFee: 0,
          percentageFee: 0,
          settings,
        },
        select: { id: true },
      });
  PaymentService.clearCache(storeId);
  return { instapay: true, configId: config.id };
}
