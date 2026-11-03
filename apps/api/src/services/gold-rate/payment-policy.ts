/**
 * Gold orders are prepaid online unless the merchant allows otherwise (Ruling SHARIA-GOLD-1). The ONE
 * server-side enforcement point: order creation (shopper + admin) and `POST /payments/create` call it,
 * so a hand-made request cannot get past a hidden checkout option.
 */
import {
  GOLD_PREPAID_ERROR_CODE,
  GOLD_PREPAID_MESSAGE,
  checkGoldPayment,
  goldAllowsDeferredPayment,
} from '@ebda/shared';
import { AppError } from '../../middleware/error-handler';

export function assertGoldPaymentAllowed(input: {
  hasGold: boolean;
  storeSettings: unknown;
  provider?: string | null;
  method?: string | null;
}): void {
  const verdict = checkGoldPayment({
    hasGold: input.hasGold,
    allowDeferred: goldAllowsDeferredPayment(input.storeSettings),
    provider: input.provider,
    method: input.method,
  });
  if (!verdict.ok) throw new AppError(409, GOLD_PREPAID_ERROR_CODE, GOLD_PREPAID_MESSAGE.en);
}
