/**
 * Wave 2 (plan 4 C2): shipping tools. Each calls the SAME service its admin route calls and carries the route's own gate.
 *  - `shipping_rate_set`   -> ShippingService.updateAreaRate (PATCH /stores/:storeId/shipping/area-rates/:id, `authorize('store_admin')`).
 *    The merchant's rates screen edits AREA rates (the legacy per-zone table is not edited here).
 *  - `checkout_delivery_set` -> StoreService.update with the keys the delivery page writes (PUT /stores/:id, `authorize('store_admin')` + MFA enrolment,
 *    which `runAsMerchant` cannot re-check: a super admin never acts here, and owner MFA is opt-in at login).
 *  - `carrier_settings`    -> shippingCarrierService.upsertCarrierConfig (PUT .../shipping-carriers/configs/:carrier, `authorize('store_admin')` +
 *    `requireFeature('shipping_carriers')`). Only the enable / default switches: a credential, API key or webhook secret is NEVER accepted or returned
 *    (secrets rule); the merchant enters those on the secure screen.
 * Everything a shopper sees or pays at checkout escalates to a confirmation card (touchesCheckout / changesPrice), whatever the registry's policy.
 */
import type { ToolSpec, TurnCtx } from '@ebda/shared/smart-layer';
import { deliveryDaysSchema, deliveryOffDaysSchema } from '@ebda/shared';
import { AppError } from '../../middleware/error-handler';
import { ShippingService } from '../../services/shipping.service';
import { StoreService } from '../../services/store.service';
import { shippingCarrierService } from '../../services/shipping-carrier.service';
import { assertMayConfigureCarrier } from '../../services/carriers/carrier-connection.service';
import { CARRIER_CODES, type CarrierCode } from '../../services/carriers/types';
import { change, egp, f, pair, row, shape } from './kit';
import { fld, readStoreRow } from './store-settings.tools';

type Rec = Record<string, unknown>;
const STORE_ROLES = ['store_admin'] as const; // the routes' `authorize('store_admin', 'super_admin')`; a super admin never acts through the assistant
const toMinor = (x: number) => Math.round(x * 100);

// ---- shipping.zones-rates ------------------------------------------------------------------------------------------------------------------
type RateEdit = {
  rateId: string;
  deliveryFeeEgp?: number;
  freeShippingOverEgp?: number | null;
  isActive?: boolean;
};
type RateArgs = { rates: RateEdit[] };
type RateRow = {
  id: string;
  governorate: string;
  governorateAr: string;
  area: string;
  areaAr: string;
  deliveryFee: number;
  freeShippingThreshold: number | null;
  isActive: boolean;
  updatedAt: string;
};

const rateBase = shape<RateArgs>(
  {
    rates: f.list(
      f.obj(
        {
          rateId: f.id('Id of an existing area rate of this store (from the shipping page).'),
          deliveryFeeEgp: f.num('New delivery fee for the area, in EGP (a decimal, e.g. 45.5).', {
            max: 100_000,
          }),
          freeShippingOverEgp: f.nullable(
            f.num('Order total in EGP from which shipping to the area is free. null removes it.', {
              max: 10_000_000,
            })
          ),
          isActive: f.bool('false stops delivering to the area at checkout; true resumes it.'),
        },
        ['rateId']
      ),
      { min: 1, max: 50 }
    ),
  },
  ['rates']
);
const rateSchema = {
  jsonSchema: rateBase.jsonSchema,
  args: rateBase.args
    .refine(a => a.rates.every(r => Object.keys(r).length > 1), {
      message: 'every area rate needs at least one change',
    })
    .refine(a => new Set(a.rates.map(r => r.rateId)).size === a.rates.length, {
      message: 'an area appears twice',
    }),
};

const RATE_FIELD_LABELS = {
  deliveryFeeEgp: ['رسوم الشحن', 'Delivery fee'],
  freeShippingOverEgp: ['شحن مجاني فوق', 'Free shipping over'],
  isActive: ['التوصيل للمنطقة شغال', 'Delivering to the area'],
} as const;

const shippingRateSet = change<RateArgs>({
  name: 'shipping_rate_set',
  capabilityId: 'shipping.zones-rates',
  description:
    'Change the delivery fee, the free-shipping threshold or the on/off switch of existing shipping areas (rate ids come from the shipping page). Amounts are in EGP as decimal numbers (45.5 = 45 pounds 50 piasters); null removes a free-shipping threshold. What shoppers pay at checkout changes, so the merchant always confirms.',
  schema: rateSchema,
  undo: 'reversible',
  gate: { roles: STORE_ROLES },
  audit: {
    action: 'shipping.area_rate.updated',
    resourceType: 'shipping_area_rate',
    resourceId: a => (a.rates.length === 1 ? a.rates[0]!.rateId : undefined),
  },
  // Area rates are not a ref kind the adapter checks: the store-scoped read returns only this store's rows, so a foreign id is a 404 here and never reaches `run`.
  state: async (ctx, a) => {
    const ids = [...new Set(a.rates.map(r => r.rateId))].sort();
    const rows = (await ShippingService.getAreaRatesByIds(ctx.storeId, ids)) as unknown as Array<
      Omit<RateRow, 'updatedAt'> & { updatedAt?: Date | string | null }
    >;
    if (rows.length !== ids.length) {
      throw new AppError(404, 'NOT_FOUND', 'Shipping area rate not found');
    }
    return rows
      .map(r => ({
        id: r.id,
        governorate: r.governorate,
        governorateAr: r.governorateAr,
        area: r.area,
        areaAr: r.areaAr,
        deliveryFee: r.deliveryFee,
        freeShippingThreshold: r.freeShippingThreshold ?? null,
        isActive: r.isActive,
        updatedAt: r.updatedAt ? new Date(r.updatedAt).toISOString() : '',
      }))
      .sort((x, y) => (x.id < y.id ? -1 : 1));
  },
  describe: (_ctx, a, st) => {
    const byId = new Map((st as RateRow[]).map(r => [r.id, r]));
    const rows = [];
    const restore: RateEdit[] = [];
    let priceTouched = false;
    for (const e of a.rates) {
      const cur = byId.get(e.rateId)!;
      const undo: RateEdit = { rateId: e.rateId };
      if (e.deliveryFeeEgp !== undefined) {
        priceTouched = true;
        undo.deliveryFeeEgp = cur.deliveryFee / 100;
        rows.push(
          row(
            `${RATE_FIELD_LABELS.deliveryFeeEgp[0]}: ${cur.areaAr}`,
            `${RATE_FIELD_LABELS.deliveryFeeEgp[1]}: ${cur.area}`,
            egp(cur.deliveryFee),
            e.deliveryFeeEgp
          )
        );
      }
      if (e.freeShippingOverEgp !== undefined) {
        priceTouched = true;
        undo.freeShippingOverEgp =
          cur.freeShippingThreshold === null ? null : cur.freeShippingThreshold / 100;
        rows.push(
          row(
            `${RATE_FIELD_LABELS.freeShippingOverEgp[0]}: ${cur.areaAr}`,
            `${RATE_FIELD_LABELS.freeShippingOverEgp[1]}: ${cur.area}`,
            egp(cur.freeShippingThreshold),
            e.freeShippingOverEgp
          )
        );
      }
      if (e.isActive !== undefined) {
        undo.isActive = cur.isActive;
        rows.push(
          row(
            `${RATE_FIELD_LABELS.isActive[0]}: ${cur.areaAr}`,
            `${RATE_FIELD_LABELS.isActive[1]}: ${cur.area}`,
            cur.isActive,
            e.isActive
          )
        );
      }
      restore.push(undo);
    }
    return {
      summary: pair(
        `هغيّر شحن ${a.rates.length} منطقة`,
        `Change shipping for ${a.rates.length} area(s)`
      ),
      rows,
      affectedCount: a.rates.length,
      restore: { rates: restore },
      touchesCheckout: true, // the rate shoppers pay at checkout
      ...(priceTouched ? { changesPrice: true } : {}),
    };
  },
  run: async (ctx, a) => {
    for (const e of a.rates) {
      const patch: Rec = {};
      if (e.deliveryFeeEgp !== undefined) patch.deliveryFee = toMinor(e.deliveryFeeEgp);
      if (e.freeShippingOverEgp !== undefined)
        patch.freeShippingThreshold =
          e.freeShippingOverEgp === null ? null : toMinor(e.freeShippingOverEgp);
      if (e.isActive !== undefined) patch.isActive = e.isActive;
      const updated = await ShippingService.updateAreaRate(ctx.storeId, e.rateId, patch);
      if (!updated) throw new AppError(404, 'NOT_FOUND', 'Shipping area rate not found');
    }
    return { updated: a.rates.length };
  },
  inverse: (_a, restore) => (restore ? { tool: 'shipping_rate_set', args: restore as Rec } : null),
});

// ---- shipping.checkout-delivery ------------------------------------------------------------------------------------------------------------
type DeliveryArgs = {
  minimumOrderEgp?: number;
  deliveryDays?: { min: number; max: number } | null;
  deliveryOffDays?: number[] | null;
  daysAhead?: number | null;
};
const deliveryBase = shape<DeliveryArgs>(
  {
    minimumOrderEgp: f.num(
      'Smallest order total in EGP the store accepts at checkout (decimal). 0 means no minimum.',
      { max: 10_000_000 }
    ),
    deliveryDays: f.nullable(
      fld(deliveryDaysSchema, {
        type: 'object',
        properties: {
          min: { type: 'integer', minimum: 0, maximum: 30 },
          max: { type: 'integer', minimum: 0, maximum: 30 },
        },
        required: ['min', 'max'],
        additionalProperties: false,
        description:
          'Delivery time shown to shoppers in business days, min <= max. null clears it.',
      })
    ),
    deliveryOffDays: f.nullable(
      fld(deliveryOffDaysSchema, {
        type: 'array',
        items: { type: 'integer', minimum: 0, maximum: 6 },
        maxItems: 6,
        description:
          'Weekdays with no delivery, 0 = Sunday ... 6 = Saturday (at most 6, unique). [] delivers every day. null resets to the default (Friday only).',
      })
    ),
    daysAhead: f.nullable(
      f.int(
        'How many delivery days ahead a shopper can pick at checkout, 1 to 14. null = today or tomorrow.',
        {
          min: 1,
          max: 14,
        }
      )
    ),
  },
  []
);
const deliverySchema = {
  jsonSchema: deliveryBase.jsonSchema,
  args: deliveryBase.args.refine(a => Object.keys(a).length > 0, {
    message: 'send at least one field',
  }),
};
const DELIVERY_LABELS: Record<string, [string, string]> = {
  minimumOrderEgp: ['أقل قيمة للطلب', 'Minimum order'],
  deliveryDays: ['مدة التوصيل (أيام عمل)', 'Delivery time (business days)'],
  deliveryOffDays: ['أيام بدون توصيل', 'Days without delivery'],
  daysAhead: ['أيام الحجز قدام', 'Delivery days shoppers can pick ahead'],
};

const checkoutDeliverySet = change<DeliveryArgs>({
  name: 'checkout_delivery_set',
  capabilityId: 'shipping.checkout-delivery',
  description:
    'Change what shoppers see and are held to at checkout: the minimum order value (EGP, decimal; 0 = none), the delivery time in business days, the weekdays with no delivery (0 = Sunday ... 6 = Saturday) and how many days ahead a delivery day can be picked. Delivery windows and the checkout note stay on the Delivery page. The merchant always confirms because shoppers see it.',
  schema: deliverySchema,
  undo: 'reversible',
  gate: { roles: STORE_ROLES },
  audit: { action: 'store.checkout_delivery.updated', resourceType: 'store' },
  state: async ctx => {
    const s = ((await readStoreRow(ctx, { settings: true })).settings as Rec | null) ?? {};
    return {
      minimumOrderFils: typeof s.minimumOrderFils === 'number' ? s.minimumOrderFils : 0,
      deliveryDays: s.deliveryDays ?? null,
      deliveryOffDays: s.deliveryOffDays ?? null,
      checkoutDelivery: s.checkoutDelivery ?? null,
    };
  },
  describe: (_ctx, a, st) => {
    const cur = st as {
      minimumOrderFils: number;
      deliveryDays: unknown;
      deliveryOffDays: unknown;
      checkoutDelivery: Rec | null;
    };
    const valid = <T>(
      schema: { safeParse: (v: unknown) => { success: boolean; data?: T } },
      v: unknown
    ) => {
      const p = schema.safeParse(v);
      return p.success ? (p.data as T) : null;
    };
    const before: Record<keyof DeliveryArgs, unknown> = {
      minimumOrderEgp: cur.minimumOrderFils / 100,
      deliveryDays: valid(deliveryDaysSchema, cur.deliveryDays),
      deliveryOffDays: valid(deliveryOffDaysSchema, cur.deliveryOffDays),
      daysAhead:
        typeof cur.checkoutDelivery?.daysAhead === 'number' ? cur.checkoutDelivery.daysAhead : null,
    };
    const keys = Object.keys(a) as Array<keyof DeliveryArgs>;
    return {
      summary: pair(
        `هغيّر إعدادات التوصيل في الدفع (${keys.length})`,
        `Change checkout delivery settings (${keys.length})`
      ),
      rows: keys.map(k => row(DELIVERY_LABELS[k]![0], DELIVERY_LABELS[k]![1], before[k], a[k])),
      affectedCount: 1,
      restore: Object.fromEntries(keys.map(k => [k, before[k]])),
      touchesCheckout: true,
    };
  },
  run: async (ctx, a, st) => {
    const cur = st as { checkoutDelivery: Rec | null };
    const settings: Rec = {};
    if (a.minimumOrderEgp !== undefined) settings.minimumOrderFils = toMinor(a.minimumOrderEgp);
    if (a.deliveryDays !== undefined) settings.deliveryDays = a.deliveryDays;
    if (a.deliveryOffDays !== undefined) settings.deliveryOffDays = a.deliveryOffDays;
    // `checkoutDelivery` is replaced as a whole key by the shallow settings merge: carry the merchant's windows and note through.
    if (a.daysAhead !== undefined)
      settings.checkoutDelivery = { ...(cur.checkoutDelivery ?? {}), daysAhead: a.daysAhead };
    return StoreService.update(ctx.storeId, { settings } as never);
  },
  inverse: (_a, restore) =>
    restore && Object.keys(restore as Rec).length > 0
      ? { tool: 'checkout_delivery_set', args: restore as Rec }
      : null,
});

// ---- shipping.carriers ---------------------------------------------------------------------------------------------------------------------
type CarrierArgs = { carrier: CarrierCode; enabled?: boolean; isDefault?: boolean };
const carrierBase = shape<CarrierArgs>(
  {
    carrier: f.enum([...CARRIER_CODES] as [string, ...string[]], 'The shipping company.'),
    enabled: f.bool(
      'true turns the carrier on (it must already be connected and tested); false turns it off.'
    ),
    isDefault: f.bool('true makes it the default carrier for new shipments (it must be on).'),
  },
  ['carrier']
);
const carrierSchema = {
  jsonSchema: carrierBase.jsonSchema,
  args: carrierBase.args.refine(a => a.enabled !== undefined || a.isDefault !== undefined, {
    message: 'send enabled and / or isDefault',
  }),
};
type CarrierState = { carrier: string; exists: boolean; enabled: boolean; isDefault: boolean };

const carrierSettings = change<CarrierArgs>({
  name: 'carrier_settings',
  capabilityId: 'shipping.carriers',
  description:
    "Turn an already connected shipping company on or off and choose the default one (Bosta, ShipBlu, Mylerz, Aramex, manual delivery). It never takes or shows a login, API key or secret: credentials are entered by the merchant on the secure shipping-companies screen, and a carrier that is not connected and tested there cannot be turned on. The default carrier is the one every Ship press books with, and the courier fees are charged by the carrier to the merchant's own carrier account (not by Ebda Store).",
  schema: carrierSchema,
  undo: 'reversible',
  gate: { roles: STORE_ROLES, feature: 'shipping_carriers' },
  audit: {
    action: 'shipping_carrier_config.updated',
    resourceType: 'shipping_carrier_config',
    resourceId: a => a.carrier,
  },
  state: async (ctx, a): Promise<CarrierState> => {
    assertMayConfigureCarrier(a.carrier, ctx.role);
    const rows = (await shippingCarrierService.getPublicCarrierConfigs(ctx.storeId)) as Array<{
      carrier: string;
      enabled: boolean;
      isDefault: boolean;
    }>;
    const r = rows.find(x => x.carrier === a.carrier);
    return {
      carrier: a.carrier,
      exists: Boolean(r),
      enabled: Boolean(r?.enabled),
      isDefault: Boolean(r?.isDefault),
    };
  },
  describe: (_ctx, a, st) => {
    const cur = st as CarrierState;
    const rows = [];
    const restore: Rec = { carrier: a.carrier };
    if (a.enabled !== undefined) {
      rows.push(
        row(`شركة الشحن شغالة: ${a.carrier}`, `Carrier on: ${a.carrier}`, cur.enabled, a.enabled)
      );
      restore.enabled = cur.enabled;
    }
    if (a.isDefault !== undefined) {
      rows.push(
        row(
          `شركة الشحن الأساسية: ${a.carrier}`,
          `Default carrier: ${a.carrier}`,
          cur.isDefault,
          a.isDefault
        )
      );
      restore.isDefault = cur.isDefault;
    }
    return {
      summary: pair(
        `هغيّر إعدادات شركة الشحن ${a.carrier}`,
        `Change carrier settings for ${a.carrier}`
      ),
      rows,
      affectedCount: 1,
      restore,
    };
  },
  run: (ctx, a) =>
    shippingCarrierService.upsertCarrierConfig(ctx.storeId, a.carrier, {
      ...(a.enabled !== undefined ? { enabled: a.enabled } : {}),
      ...(a.isDefault !== undefined ? { isDefault: a.isDefault } : {}),
    }),
  inverse: (_a, restore) => (restore ? { tool: 'carrier_settings', args: restore as Rec } : null),
});

/** Wave 2 (plan 4 C2): shipping tools. */
export function shippingTools(): ToolSpec[] {
  return [shippingRateSet, checkoutDeliverySet, carrierSettings];
}

export type { TurnCtx };
