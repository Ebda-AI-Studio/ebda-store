import { getProviderEntry } from '@ebda/shared';
import { AppError } from '../middleware/error-handler';

/**
 * The legacy enable routes (`/toggle`, the carrier PUT) refuse a merchant turning a non-manual provider ON: a
 * checkout-visible switch needs the confirm step (`/activate/preview` then `/activate/confirm`). Turning OFF stays
 * free; manual providers (COD, InstaPay) need no activation; super_admin keeps the override.
 */
export function refuseUnconfirmedEnable(role: string | undefined, provider: string): void {
  const entry = getProviderEntry(provider);
  if (!entry || entry.manual || role === 'super_admin') return;
  throw new AppError(
    409,
    'CONFIRMATION_REQUIRED',
    'Turning a provider on needs a confirmation: POST /provider-activation/store/:storeId/:provider/activate/preview, then .../activate/confirm with the token and an Idempotency-Key'
  );
}
