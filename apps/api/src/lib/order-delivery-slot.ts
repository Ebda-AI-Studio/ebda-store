import {
  checkDeliveryPick,
  deliveryDateChoices,
  deliveryDaysSchema,
  deliveryNoteLine,
  type DeliveryDateWindow,
} from '@ebda/shared';
import { AppError } from '../middleware/error-handler';

/** One merchant window as the order note needs it (`CheckoutDeliveryWindow`, loosely typed JSON). */
interface RawWindow {
  id: string;
  label: string;
  labelAr: string;
  start: string;
  end: string;
  orderBy?: string;
}

const REFUSAL: Record<string, string> = {
  DATE_REQUIRED: 'Choose a delivery date.',
  DATE_UNAVAILABLE: 'The delivery date you chose is no longer available. Please pick another.',
  WINDOW_REQUIRED: 'Choose a delivery time for that date.',
  WINDOW_UNAVAILABLE: 'The delivery time you chose is no longer available. Please pick another.',
};

/**
 * Ruling B4-7: the order endpoint is the single writer of a date store's delivery note.
 *
 * For a store with `settings.checkoutDelivery.daysAhead` the offered set is RECOMPUTED here from
 * the live store row (settings, timezone) and the cart's longest product lead time, with the same
 * pure function the storefront uses (`deliveryDateChoices`); a pick outside it is 422
 * DELIVERY_SLOT_UNAVAILABLE. The client never writes the note for such a store. A store without
 * `daysAhead` returns null (today's behaviour: the client-written note, nothing validated).
 *
 * CACHE CLASS: NEVER-stale. `settings` and `timezone` come from the store row read in the order's
 * own transaction, never from a cache, so an off-day, window or lead-time edit applies to the very
 * next order (the storefront copy can only make the HINT stale).
 *
 * `enforce` = a storefront order (source web): a missing date is refused. Other sources
 * (WhatsApp, the agent checkout) may omit it and get no delivery line; a date they DO send is
 * validated the same way.
 */
export function resolveOrderDeliveryNote(a: {
  settings: Record<string, unknown> | null | undefined;
  timeZone: string | null | undefined;
  now: Date;
  maxLeadTimeDays: number;
  deliveryDate?: string | null;
  deliveryWindowId?: string | null;
  locale?: string | null;
  enforce: boolean;
}): string | null {
  const cd = a.settings?.checkoutDelivery as
    | { daysAhead?: unknown; windows?: { enabled?: boolean; items?: RawWindow[] } }
    | undefined;
  const daysAhead = typeof cd?.daysAhead === 'number' ? cd.daysAhead : null;
  if (!cd || daysAhead === null) return null;
  if (!a.enforce && !a.deliveryDate) return null;

  const items = cd.windows?.enabled && Array.isArray(cd.windows.items) ? cd.windows.items : [];
  const windows: DeliveryDateWindow[] = items.map(w => ({
    id: w.id,
    start: w.start,
    orderBy: w.orderBy,
  }));
  const est = deliveryDaysSchema.safeParse(a.settings?.deliveryDays);
  const offDays = Array.isArray(a.settings?.deliveryOffDays)
    ? (a.settings?.deliveryOffDays as number[])
    : null;
  const choices = deliveryDateChoices({
    now: a.now,
    timeZone: a.timeZone ?? undefined,
    offDays,
    windows,
    daysAhead,
    estimateDays: est.success ? est.data.min : 0,
    maxLeadTimeDays: a.maxLeadTimeDays,
  });
  const pick = checkDeliveryPick(
    choices,
    { deliveryDate: a.deliveryDate, deliveryWindowId: a.deliveryWindowId },
    windows.length > 0
  );
  if (!pick.ok)
    throw new AppError(422, 'DELIVERY_SLOT_UNAVAILABLE', REFUSAL[pick.reason], {
      reason: pick.reason,
    });
  if (!pick.date) return null;
  const win = pick.windowId ? items.find(w => w.id === pick.windowId) : undefined;
  return deliveryNoteLine({
    locale: a.locale === 'ar' ? 'ar' : 'en',
    date: pick.date,
    window: win ?? null,
  });
}
