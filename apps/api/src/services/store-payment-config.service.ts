import {
  codSettingsSchema,
  fawrySettingsSchema,
  instapaySettingsBaseSchema,
  instapaySettingsSchema,
  kashierSettingsSchema,
} from '@ebda/shared';
import { storeWriter } from '../lib/repo-factory';
import { AppError } from '../middleware/error-handler';
import { assertEnableAllowed } from './payment-providers/provider-connection.service';
import { PaymentService } from './payment.service';

/**
 * Validate and normalise the NON-secret `settings` JSON of one provider config.
 * InstaPay needs a handle or a phone once it is enabled (a disabled draft may be
 * partial); COD takes an optional percentage. Anything else carries no settings.
 */
export function normalizeProviderSettings(
  provider: string,
  settings: Record<string, unknown> | undefined,
  isEnabled: boolean
): Record<string, unknown> {
  const raw = settings ?? {};
  if (provider === 'instapay') {
    const parsed = (isEnabled ? instapaySettingsSchema : instapaySettingsBaseSchema).safeParse(raw);
    if (!parsed.success) {
      throw new AppError(
        422,
        'INVALID_PAYMENT_SETTINGS',
        parsed.error.issues.map(i => `${i.path.join('.') || 'settings'}: ${i.message}`).join('; ')
      );
    }
    return parsed.data;
  }
  if (provider === 'cod') {
    const parsed = codSettingsSchema.safeParse(raw);
    if (!parsed.success) {
      throw new AppError(422, 'INVALID_PAYMENT_SETTINGS', 'percentBps must be 0-5000');
    }
    return parsed.data;
  }
  // The Egyptian gateways: only their mode-independent, NON-secret settings live here. Paymob's
  // public key and integration ids differ between sandbox and live, so they are credential fields
  // of the catalog (encrypted blob, per mode) and Paymob keeps nothing in this column.
  if (provider === 'paymob') return {};
  const gatewaySchema =
    provider === 'kashier'
      ? kashierSettingsSchema
      : provider === 'fawry'
        ? fawrySettingsSchema
        : null;
  if (gatewaySchema) {
    const parsed = gatewaySchema.safeParse(raw);
    if (!parsed.success) {
      throw new AppError(
        422,
        'INVALID_PAYMENT_SETTINGS',
        parsed.error.issues.map(i => `${i.path.join('.') || 'settings'}: ${i.message}`).join('; ')
      );
    }
    return parsed.data;
  }
  return {};
}

/** The stored row fields the enable gate and the settings merge read. */
interface ExistingPaymentConfig {
  id: string;
  isEnabled: boolean;
  testMode: boolean;
  credentials: unknown;
  connectionTest: unknown;
  settings: unknown;
}

/**
 * The write half of `PUT /payment-settings/store/:storeId/:provider` (moved here unchanged so the assistant `cod_settings` tool and the route
 * share ONE writer): the enable gate on the RESULTING state (enabling, or switching the mode of an enabled gateway, needs a current Test
 * connection; manual providers like COD are not gated), the non-secret settings merge, the default-flag swap and the row update as one atomic
 * unit, then the provider cache is cleared. `updateData` carries the already-prepared columns (the route encrypts credentials into it first;
 * the assistant never passes any). Returns the updated row.
 */
export async function applyStorePaymentConfigUpdate(
  storeId: string,
  provider: string,
  existing: ExistingPaymentConfig,
  data: {
    isEnabled?: boolean;
    testMode?: boolean;
    isDefault?: boolean;
    settings?: Record<string, unknown>;
  },
  updateData: Record<string, unknown>
) {
  // The enable gate on the RESULTING state: enabling, or switching the mode of an enabled
  // gateway (the other mode's credentials were never tested), needs a current test.
  const resultingEnabled = data.isEnabled ?? existing.isEnabled;
  if (resultingEnabled) {
    assertEnableAllowed({
      provider,
      testMode: data.testMode ?? existing.testMode,
      isEnabled: true,
      credentials: existing.credentials,
      connectionTest: existing.connectionTest,
    } as Parameters<typeof assertEnableAllowed>[0]);
  }

  if (data.settings !== undefined || data.isEnabled !== undefined) {
    updateData.settings = normalizeProviderSettings(
      provider,
      {
        ...((existing.settings as Record<string, unknown> | null) ?? {}),
        ...(data.settings ?? {}),
      },
      data.isEnabled ?? existing.isEnabled
    );
  }

  // Unsetting the other default and updating this row are ONE atomic unit (see the create route).
  const w = await storeWriter(storeId);
  const [, config] = await w.$transaction([
    w.paymentConfig.updateMany({
      where: data.isDefault
        ? { storeId, isDefault: true, id: { not: existing.id } }
        : { storeId, id: { in: [] } },
      data: { isDefault: false },
    }),
    w.paymentConfig.update({ where: { id: existing.id, storeId }, data: updateData }),
  ]);

  // Clear provider cache for this store
  PaymentService.clearCache(storeId);
  return config;
}
