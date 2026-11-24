/**
 * Merchant add-on purchase (SELF-SERVICE A8 + A9, money). The merchant previews the exact charge, then confirms with a
 * server-issued token (single use, bound to store + user + sku + the integer total) and a client Idempotency-Key; the
 * hosted card page (the same Kashier flow as a plan checkout) takes the money; the signed webhook settles the ledger
 * row and `applyAddonGrant` grants the term in the same transaction (see addon-grant.ts). Everything here runs under a
 * store scope and never holds a transaction across the gateway call.
 *
 * Super-admin override stays elsewhere: `PUT /admin/stores/:id/features/:key` (goodwill grant/revoke) is untouched.
 */
import { withStore } from '@ebda/database';
import { AppError } from '../../middleware/error-handler';
import { config } from '../../config';
import logger from '../../lib/logger';
import { withIdempotencyKey } from '../../lib/money-idempotency';
import { maxStoreDailyRequests, storeAiAllowance, storeAiExtraRequests } from '../../lib/ai-quota';
import {
  consumeConfirmToken,
  hashConfirmArgs,
  signConfirmToken,
  verifyConfirmToken,
  type ConfirmTokenSubject,
} from '../../mcp/merchant-confirm-token';
import { featureService } from '../feature.service';
import { getBillingProvider, resolveTrialCardMode } from './index';
import { assertPayableStore } from './account.service';
import { chargeFor } from './charge-amount';
import { claimEvent, markFailedUnlessSettled } from './subscription-billing.service';
import {
  ADDON_CATALOG,
  ADDON_TERM_DAYS,
  planCodeOfSku,
  renewsEachTerm,
  type AddonItem,
} from './addon-catalog';
import { activeAddons, appendRenewalMarker } from './addon-grant';
import { canBuyFeatureOnPlan } from '@ebda/shared';

const TOOL = 'billing.addon-purchase';

function itemOf(sku: string): AddonItem {
  const item = ADDON_CATALOG[sku];
  if (!item) throw new AppError(404, 'ADDON_NOT_FOUND', 'This add-on does not exist');
  return item;
}

/** What the merchant agrees to, INCLUDING the renewal: the token binds all of it (ADDON-RENEW-1). */
function terms(item: AddonItem, totalMinor: number) {
  const renews = renewsEachTerm(item);
  return {
    sku: item.sku,
    totalMinor,
    renews,
    renewsEveryDays: renews ? ADDON_TERM_DAYS : 0,
    renewalMinor: renews ? totalMinor : 0,
  };
}

const subject = (a: {
  storeId: string;
  userId: string;
  terms: ReturnType<typeof terms>;
}): ConfirmTokenSubject => ({
  tool: TOOL,
  storeId: a.storeId,
  keyId: 'admin-ui',
  userId: a.userId,
  argsHash: hashConfirmArgs(a.terms),
});

/** Everything a quote and a purchase must agree on; refuses what must not be sold. */
export async function quoteAddon(
  storeId: string,
  sku: string,
  opts: { card: boolean } = { card: true }
) {
  const item = itemOf(sku);
  await assertPayableStore(storeId);
  if (opts.card && resolveTrialCardMode() !== 'card_on_file') {
    throw new AppError(409, 'CARD_PAYMENTS_DISABLED', 'Card payments are not available yet');
  }
  const [store, sub, running] = await Promise.all([
    withStore(storeId, tx =>
      tx.store.findUnique({
        where: { id: storeId },
        select: {
          name: true,
          plan: true,
          settings: true,
          owner: { select: { email: true, firstName: true } },
        },
      })
    ),
    withStore(storeId, tx => tx.storeSubscription.findUnique({ where: { storeId } })),
    withStore(storeId, tx => activeAddons(tx, storeId, new Date())),
  ]);
  if (!store) throw new AppError(404, 'STORE_NOT_FOUND', 'Store not found');
  // An InstaPay payment for this add-on is already waiting for a super admin: never sell it a second way meanwhile.
  const waiting = await withStore(storeId, tx =>
    tx.manualPaymentClaim.count({
      where: { storeId, status: 'pending', planCode: planCodeOfSku(sku) },
    })
  );
  if (waiting > 0)
    throw new AppError(
      409,
      'ADDON_AWAITING_CONFIRMATION',
      'This add-on is already waiting for confirmation'
    );
  if (!store.owner?.email)
    throw new AppError(409, 'NO_BILLING_EMAIL', 'The store owner has no email address');
  if (sub?.status === 'comped')
    throw new AppError(409, 'STORE_COMPED', 'Comped stores are not billed');
  if (item.kind === 'ai_topup') {
    // Never sell capacity the platform cannot back (money-abuse audit P6): base + packs <= one store's share of the day.
    const extra = await storeAiExtraRequests(storeId);
    const base = (await storeAiAllowance(storeId)).baseCap;
    if (base + extra + (item.aiExtraRequests ?? 0) > maxStoreDailyRequests())
      throw new AppError(
        409,
        'AI_CAPACITY_UNAVAILABLE',
        'The shared AI capacity cannot back this top-up right now. Nothing was charged.'
      );
  }
  if (item.kind === 'feature' && !canBuyFeatureOnPlan(String(store.plan), item.featureKey!)) {
    // Business holds every feature; Free picks a plan first; Basic/Growth only buy what their own plan lacks.
    const topPlan = store.plan === 'enterprise';
    throw new AppError(
      409,
      topPlan ? 'ALREADY_INCLUDED' : 'ADDON_NOT_FOR_PLAN',
      topPlan
        ? 'Your plan already includes this feature'
        : 'This feature cannot be added to your current plan. Choose a plan first.'
    );
  }
  if (item.kind === 'feature') {
    // A super-admin "off" (abuse, dispute) is never sold around: the owner contacts support instead.
    const off = await withStore(storeId, tx =>
      tx.storeFeature.findFirst({
        where: { storeId, featureKey: item.featureKey!, enabled: false },
        select: { featureKey: true },
      })
    );
    if (off)
      throw new AppError(
        409,
        'FEATURE_DISABLED_BY_SUPPORT',
        'Support switched this feature off for your store. Contact support to turn it back on.'
      );
    const on = await featureService.isFeatureEnabled(storeId, item.featureKey!);
    if (on && !running.some(r => r.sku === sku)) {
      throw new AppError(409, 'ALREADY_INCLUDED', 'Your plan already includes this feature');
    }
  }
  const amount = await chargeFor(item.priceMinor);
  return { item, store, amount };
}

export async function previewAddon(a: { storeId: string; userId: string; sku: string }) {
  const { item, amount } = await quoteAddon(a.storeId, a.sku);
  const t = terms(item, amount.totalMinor);
  return {
    sku: item.sku,
    nameEn: item.nameEn,
    nameAr: item.nameAr,
    netMinor: amount.netMinor,
    vatMinor: amount.vatMinor,
    totalMinor: amount.totalMinor,
    termDays: ADDON_TERM_DAYS,
    renews: t.renews,
    renewsEveryDays: t.renewsEveryDays,
    renewalMinor: t.renewalMinor,
    confirmToken: signConfirmToken(subject({ storeId: a.storeId, userId: a.userId, terms: t })),
  };
}

export async function purchaseAddon(a: {
  storeId: string;
  userId: string;
  sku: string;
  confirmToken: string | undefined;
  idempotencyKey: string | undefined;
}): Promise<{ redirectUrl: string; billingEventId: string }> {
  const { value } = await withIdempotencyKey(
    `addon-checkout:${a.storeId}`,
    a.idempotencyKey,
    async () => {
      const { item, store, amount } = await quoteAddon(a.storeId, a.sku);
      const subj = subject({
        storeId: a.storeId,
        userId: a.userId,
        terms: terms(item, amount.totalMinor),
      });
      if (!a.confirmToken || !verifyConfirmToken(a.confirmToken, subj)) {
        throw new AppError(
          409,
          'CONFIRMATION_REQUIRED',
          'Review the price and confirm again. The confirmation expired, was already used, or the price changed.'
        );
      }
      // Single use: the first consumer wins, a replay is refused. Fails closed when it cannot arbitrate.
      let first: boolean;
      try {
        first = await consumeConfirmToken(a.confirmToken);
      } catch {
        throw new AppError(
          503,
          'CONFIRMATION_UNAVAILABLE',
          'Try again shortly; nothing was charged'
        );
      }
      if (!first)
        throw new AppError(
          409,
          'CONFIRMATION_REQUIRED',
          'This confirmation was already used. Review and confirm again.'
        );

      const provider = getBillingProvider();
      const eventId = await claimEvent({
        storeId: a.storeId,
        type: 'upgrade',
        planCode: planCodeOfSku(item.sku),
        amountMinor: amount.totalMinor,
        charge: amount,
        provider: provider.name,
        idempotencyKey: `addon:${a.storeId}:${item.sku}:${a.idempotencyKey}`,
      });
      if (!eventId)
        throw new AppError(409, 'CHECKOUT_IN_PROGRESS', 'This purchase was already started');
      const lang: 'ar' | 'en' =
        (store.settings as { defaultLanguage?: string } | null)?.defaultLanguage === 'en'
          ? 'en'
          : 'ar';
      try {
        const out = await provider.createCheckoutForSubscription({
          merchantOrderId: eventId,
          amountMinor: amount.totalMinor,
          currency: 'EGP',
          description: item.nameEn,
          customer: {
            reference: a.storeId,
            email: store.owner!.email,
            name: store.owner!.firstName,
          },
          returnUrl: `${config.adminUrl}/stores/${a.storeId}/billing/addons?checkout=return`,
          webhookUrl: `${config.apiUrl}/api/v1/webhooks/billing/${provider.name}`,
          locale: lang,
        });
        return { redirectUrl: out.redirectUrl, billingEventId: eventId };
      } catch (err) {
        // Nothing was charged and nothing is granted: close the row so it cannot be settled later by accident.
        await markFailedUnlessSettled(eventId, `checkout_error: ${(err as Error).message}`);
        logger.error({ err, storeId: a.storeId, sku: a.sku }, '[addons] createCheckout failed');
        throw new AppError(
          502,
          'BILLING_PROVIDER_ERROR',
          'Could not start the checkout, try again'
        );
      }
    },
    () => false,
    { required: true }
  );
  return value;
}

async function latestRunning(storeId: string, sku: string) {
  const running = (await withStore(storeId, tx => activeAddons(tx, storeId, new Date())))
    .filter(r => r.sku === sku)
    .sort((x, y) => y.endsAt.getTime() - x.endsAt.getTime());
  return running[0] ?? null;
}

async function setCancelFlag(
  storeId: string,
  sku: string,
  cancel: boolean
): Promise<{ effectiveAt: Date }> {
  const item = itemOf(sku);
  if (item.kind !== 'feature')
    throw new AppError(
      409,
      'NOT_RECURRING',
      'This pack does not renew, so there is nothing to cancel'
    );
  const run = await latestRunning(storeId, sku);
  if (!run) throw new AppError(409, 'NOTHING_TO_CANCEL', 'This add-on is not running');
  // Append-only: the intent is a new zero-amount ledger row, the paid row is never edited.
  await withStore(storeId, tx =>
    appendRenewalMarker(tx, { storeId, termId: run.eventId, sku, cancel })
  );
  return { effectiveAt: run.endsAt };
}

/** Stops the renewal; the add-on keeps working until the term the merchant paid for ends. */
export const cancelAddon = (a: { storeId: string; sku: string }) =>
  setCancelFlag(a.storeId, a.sku, true);
export const resumeAddon = (a: { storeId: string; sku: string }) =>
  setCancelFlag(a.storeId, a.sku, false);

export async function listAddons(storeId: string) {
  const now = new Date();
  const [running, features, ai] = await Promise.all([
    withStore(storeId, tx => activeAddons(tx, storeId, now)),
    featureService.getStoreFeatures(storeId),
    storeAiAllowance(storeId),
  ]);
  let cardAvailable = true;
  try {
    cardAvailable = resolveTrialCardMode() === 'card_on_file';
  } catch {
    cardAvailable = false;
  }
  return {
    cardAvailable,
    termDays: ADDON_TERM_DAYS,
    addons: Object.values(ADDON_CATALOG).map(i => {
      const mine = running
        .filter(r => r.sku === i.sku)
        .sort((x, y) => y.endsAt.getTime() - x.endsAt.getTime());
      return {
        sku: i.sku,
        kind: i.kind,
        nameEn: i.nameEn,
        nameAr: i.nameAr,
        priceMinor: i.priceMinor,
        aiExtraRequests: i.aiExtraRequests ?? null,
        includedInPlan:
          i.kind === 'feature' && features[i.featureKey!] === true && mine.length === 0,
        active: mine[0]
          ? { endsAt: mine[0].endsAt, cancelAtPeriodEnd: mine[0].cancelAtPeriodEnd }
          : null,
      };
    }),
    ai,
  };
}
