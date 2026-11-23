import { AppError } from '../middleware/error-handler';
import logger from '../lib/logger';
import { sendAlert } from './alerts.service';

/** Expected refusals of a shopper closing their own account: a 409 with a plain ar + en message, never a 500. */
export const CLOSURE_REFUSALS: Record<string, { en: string; ar: string }> = {
  ACCOUNT_HAS_OPEN_ORDERS: {
    en: 'You still have an order in progress. Close your account after it is delivered or cancelled.',
    ar: 'لسه عندك طلب شغال. اقفل حسابك بعد ما يوصلك أو يتلغي.',
  },
  ACCOUNT_HAS_OPEN_RETURN: {
    en: 'You still have a return or refund in progress. Close your account once it is settled.',
    ar: 'لسه عندك مرتجع أو استرداد شغال. اقفل حسابك بعد ما يخلص.',
  },
};

export const ERASURE_INCOMPLETE_MESSAGE = {
  en: 'We could not finish closing your account. It is locked and the closure will be completed shortly. Contact support if it is not.',
  ar: 'معرفناش نكمّل قفل حسابك. الحساب اتقفل مؤقتًا وهنكمّل القفل خلال وقت قصير. كلّم الدعم لو ماخلصش.',
};

const both = (m: { en: string; ar: string }) => `${m.en} | ${m.ar}`;

/**
 * The StoreDO shopper erasure as an ordered, recoverable flow (all-or-nothing from the shopper's side):
 *  1. `erase` - the store half, ONE atomic DO section (it also decides the refusals first). If it throws, NOTHING was written:
 *     the account still signs in and the caller gets a clear error (409 for a refusal).
 *  2. `eraseIdentity` - the identity half, one atomic section, idempotent. One retry; if it still fails the store data is already
 *     gone, so `lockIdentity` (status inactive + every session revoked) makes the account unable to sign in with half-erased
 *     data, and the caller gets a 503 that says so. A repeated closure replays safely (saved erasure scope + idempotent steps).
 */
export async function runShopperErasure<E, I>(
  ctx: { storeId: string; userId: string },
  steps: {
    erase: () => Promise<E>;
    eraseIdentity: () => Promise<I>;
    lockIdentity: () => Promise<unknown>;
    alert?: typeof sendAlert;
  }
): Promise<{ erase: E; identity: I }> {
  let erase: E;
  try {
    erase = await steps.erase();
  } catch (err) {
    const refusal = err instanceof AppError ? CLOSURE_REFUSALS[err.code] : undefined;
    if (refusal) throw new AppError(409, (err as AppError).code, both(refusal));
    throw err;
  }
  try {
    return { erase, identity: await steps.eraseIdentity() };
  } catch (first) {
    logger.error(
      { err: first },
      '[auth.erase] identity erase failed after the store erase; retrying'
    );
    try {
      return { erase, identity: await steps.eraseIdentity() };
    } catch (second) {
      logger.error(
        { err: second },
        '[auth.erase] identity erase failed twice; locking the account'
      );
      const locked = await steps
        .lockIdentity()
        .then(() => true)
        .catch(err => {
          logger.error({ err }, '[auth.erase] account could not be locked after a partial erase');
          return false;
        });
      // P1 with ids only (no other PII). The daily pending-erasure sweep retries the identity step until it lands.
      void (steps.alert ?? sendAlert)({
        level: 'p1',
        source: 'auth.shopper-erasure',
        title: 'Shopper closure stopped after the store erase',
        body: `The identity erase failed twice (${locked ? 'account locked' : 'account NOT locked'}). The pending-erasure sweep will retry; if it alerts again, finish it from the merchant erase route.`,
        context: { storeId: ctx.storeId, userId: ctx.userId },
      }).catch(() => undefined);
      throw new AppError(503, 'ERASURE_INCOMPLETE', both(ERASURE_INCOMPLETE_MESSAGE));
    }
  }
}
