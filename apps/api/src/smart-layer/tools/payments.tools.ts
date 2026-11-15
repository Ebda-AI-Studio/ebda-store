/**
 * Wave 2 (plan 4 C2): payment tools. Never a provider secret, key or credential: those are entered on the secure payment screen only.
 *  - `cod_settings`: cash on delivery on/off, fixed fee (EGP in, piasters stored) and percentage. Writes through `applyStorePaymentConfigUpdate`, the
 *    writer extracted from `PUT /payment-settings/store/:storeId/:provider` (gate there: `authorize('store_admin')` + `requirePermission('store:settings')`
 *    + MFA enrolment, which `runAsMerchant` cannot re-check: a super admin never acts here).
 *  - `instalments_settings`: the PDP instalment estimate (`settings.instalments`), validated with the shared `instalmentsSchema` the route also uses;
 *    written through `StoreService.update` (PUT /stores/:id, `authorize('store_admin')`).
 * Both are what shoppers see at checkout / on the product page, so both escalate to a confirmation card (touchesCheckout).
 */
import type { ToolSpec } from '@ebda/shared/smart-layer';
import { instalmentsSchema } from '@ebda/shared';
import { storeDb } from '../../lib/repo-factory';
import { AppError } from '../../middleware/error-handler';
import { StoreService } from '../../services/store.service';
import { applyStorePaymentConfigUpdate } from '../../services/store-payment-config.service';
import { change, egp, f, pair, row, shape } from './kit';
import { readStoreRow } from './store-settings.tools';

type Rec = Record<string, unknown>;
const STORE_ROLES = ['store_admin'] as const;
const toMinor = (x: number) => Math.round(x * 100);

// ---- payment.methods-cod ------------------------------------------------------------------------------------------------------------------
type CodArgs = { enabled?: boolean; feeEgp?: number; percentBps?: number };
const codBase = shape<CodArgs>(
  {
    enabled: f.bool('true turns cash on delivery on at checkout, false turns it off.'),
    feeEgp: f.num(
      'Fixed cash-on-delivery fee added to the order, in EGP (decimal, e.g. 20). 0 means no fee.',
      {
        max: 100_000,
      }
    ),
    percentBps: f.int('Percentage fee on the order total in basis points (100 = 1%), 0 to 5000.', {
      min: 0,
      max: 5000,
    }),
  },
  []
);
const codSchema = {
  jsonSchema: codBase.jsonSchema,
  args: codBase.args.refine(a => Object.keys(a).length > 0, { message: 'send at least one field' }),
};
type CodState = { id: string; isEnabled: boolean; fixedFee: number; percentBps: number };

async function readCod(storeId: string) {
  const r = await (
    await storeDb(storeId)
  ).paymentConfig.findFirst({
    where: { provider: 'cod', storeId },
  });
  if (!r) {
    throw new AppError(
      404,
      'NOT_FOUND',
      'Cash on delivery is not set up for this store yet. Open Payment settings once to create it.'
    );
  }
  return r as unknown as {
    id: string;
    isEnabled: boolean;
    fixedFee: number;
    testMode: boolean;
    credentials: unknown;
    connectionTest: unknown;
    settings: Rec | null;
  };
}

const codSettings = change<CodArgs>({
  name: 'cod_settings',
  capabilityId: 'payment.methods-cod',
  description:
    'Turn cash on delivery on or off and set its fee: a fixed fee in EGP (decimal) and / or a percentage of the order total in basis points. Shoppers see this at checkout, so the merchant always confirms. It never touches card or gateway keys or secrets: those are entered on the secure payment screen only. Disabling the last payment method stops checkout.',
  schema: codSchema,
  undo: 'reversible',
  gate: { roles: STORE_ROLES },
  audit: {
    action: 'store_payment_config.updated',
    resourceType: 'payment_config',
    resourceId: () => 'cod',
  },
  state: async (ctx): Promise<CodState> => {
    const r = await readCod(ctx.storeId);
    return {
      id: r.id,
      isEnabled: r.isEnabled,
      fixedFee: r.fixedFee ?? 0,
      percentBps: Number(r.settings?.percentBps ?? 0) || 0,
    };
  },
  describe: (_ctx, a, st) => {
    const cur = st as CodState;
    const rows = [];
    const restore: CodArgs = {};
    if (a.enabled !== undefined) {
      rows.push(row('الدفع عند الاستلام شغال', 'Cash on delivery on', cur.isEnabled, a.enabled));
      restore.enabled = cur.isEnabled;
    }
    if (a.feeEgp !== undefined) {
      rows.push(
        row('رسوم الدفع عند الاستلام (جنيه)', 'COD fixed fee (EGP)', egp(cur.fixedFee), a.feeEgp)
      );
      restore.feeEgp = cur.fixedFee / 100;
    }
    if (a.percentBps !== undefined) {
      rows.push(
        row(
          'نسبة رسوم الدفع عند الاستلام (نقطة أساس)',
          'COD percentage (basis points)',
          cur.percentBps,
          a.percentBps
        )
      );
      restore.percentBps = cur.percentBps;
    }
    return {
      summary: pair('هغيّر إعدادات الدفع عند الاستلام', 'Change cash-on-delivery settings'),
      rows,
      affectedCount: 1,
      restore,
      touchesCheckout: true,
      ...(a.feeEgp !== undefined || a.percentBps !== undefined ? { changesPrice: true } : {}),
    };
  },
  run: async (ctx, a) => {
    const existing = await readCod(ctx.storeId);
    const data: { isEnabled?: boolean; settings?: Rec } = {};
    const updateData: Rec = { updatedBy: ctx.userId };
    if (a.enabled !== undefined) {
      data.isEnabled = a.enabled;
      updateData.isEnabled = a.enabled;
    }
    if (a.feeEgp !== undefined) updateData.fixedFee = toMinor(a.feeEgp);
    if (a.percentBps !== undefined) data.settings = { percentBps: a.percentBps };
    return applyStorePaymentConfigUpdate(ctx.storeId, 'cod', existing, data, updateData);
  },
  inverse: (_a, restore) =>
    restore && Object.keys(restore as Rec).length > 0
      ? { tool: 'cod_settings', args: restore as Rec }
      : null,
});

// ---- payment.instalments ------------------------------------------------------------------------------------------------------------------
type InstArgs = {
  enabled?: boolean;
  months?: number;
  markupPct?: number;
  minPriceEgp?: number;
  providerAr?: string;
  providerEn?: string;
  remove?: boolean;
};
const instBase = shape<InstArgs>(
  {
    enabled: f.bool('true shows the instalment line on product pages.'),
    months: f.int('Number of monthly instalments, 3 to 60.', { min: 3, max: 60 }),
    markupPct: f.num('Markup percentage added to the price, 0 to 100.', { max: 100 }),
    minPriceEgp: f.num(
      'Products cheaper than this (EGP, decimal) show no instalment line. 0 = no minimum.',
      {
        max: 10_000_000,
      }
    ),
    providerAr: f.text('Provider name in Arabic, plain text, max 40 characters.', { max: 40 }),
    providerEn: f.text('Provider name in English, plain text, max 40 characters.', { max: 40 }),
    remove: f.bool('true deletes the instalment setting entirely (send nothing else).'),
  },
  []
);
const instSchema = {
  jsonSchema: instBase.jsonSchema,
  args: instBase.args
    .refine(a => Object.keys(a).length > 0, { message: 'send at least one field' })
    .refine(a => !a.remove || Object.keys(a).length === 1, {
      message: 'remove stands alone',
    }),
};
const INST_LABELS: Record<string, [string, string]> = {
  enabled: ['سطر التقسيط شغال', 'Instalment line on'],
  months: ['عدد الشهور', 'Months'],
  markupPct: ['نسبة الزيادة %', 'Markup %'],
  minPriceEgp: ['أقل سعر يظهر فيه التقسيط (جنيه)', 'Minimum price (EGP)'],
  providerAr: ['اسم الجهة (عربي)', 'Provider (Arabic)'],
  providerEn: ['اسم الجهة (إنجليزي)', 'Provider (English)'],
  remove: ['مسح إعداد التقسيط', 'Remove the instalment setting'],
};
const instToArgs = (v: Rec | null): InstArgs =>
  v === null
    ? { remove: true }
    : {
        enabled: v.enabled as boolean,
        months: v.months as number,
        markupPct: v.markupPct as number,
        minPriceEgp: ((v.minPrice as number | undefined) ?? 0) / 100,
        providerAr: (v.providerAr as string | undefined) ?? '',
        providerEn: (v.providerEn as string | undefined) ?? '',
      };
/** The stored object after the call (null = removed). Throws on an invalid result so the card is never shown for a setting the route would refuse. */
function nextInstalments(cur: Rec | null, a: InstArgs): Rec | null {
  if (a.remove) return null;
  const next: Rec = { ...(cur ?? {}) };
  if (a.enabled !== undefined) next.enabled = a.enabled;
  if (a.months !== undefined) next.months = a.months;
  if (a.markupPct !== undefined) next.markupPct = a.markupPct;
  if (a.minPriceEgp !== undefined) next.minPrice = toMinor(a.minPriceEgp);
  if (a.providerAr !== undefined) next.providerAr = a.providerAr;
  if (a.providerEn !== undefined) next.providerEn = a.providerEn;
  const p = instalmentsSchema.safeParse(next);
  if (!p.success) {
    throw new AppError(
      422,
      'INVALID_INSTALMENTS',
      `Instalment settings are not valid: ${p.error.issues.map(i => i.message).join('; ')} (months and markup are required the first time)`
    );
  }
  return p.data as Rec;
}

const instalmentsSettings = change<InstArgs>({
  name: 'instalments_settings',
  capabilityId: 'payment.instalments',
  description:
    'Show, change or remove the "pay in N monthly instalments" estimate on product pages: months (3-60), markup percentage, minimum price (EGP, decimal), and an optional provider name as plain text. It is a display estimate only, no provider is connected and checkout totals do not change. The first time, send months and markupPct as well. remove=true deletes the setting.',
  schema: instSchema,
  undo: 'reversible',
  gate: { roles: STORE_ROLES },
  audit: { action: 'store.instalments.updated', resourceType: 'store' },
  state: async ctx => {
    const s = ((await readStoreRow(ctx, { settings: true })).settings as Rec | null) ?? {};
    return { instalments: s.instalments ?? null };
  },
  describe: (_ctx, a, st) => {
    const cur = ((st as { instalments: Rec | null }).instalments ?? null) as Rec | null;
    const next = nextInstalments(cur, a);
    const keys = Object.keys(a);
    const beforeArgs = cur === null ? null : instToArgs(cur);
    const rows = keys.map(k => {
      const after = (a as Rec)[k];
      const before =
        beforeArgs === null ? null : k === 'remove' ? false : ((beforeArgs as Rec)[k] ?? null);
      return row(INST_LABELS[k]![0], INST_LABELS[k]![1], before, after);
    });
    void next;
    return {
      summary: pair(
        'هغيّر سطر التقسيط في صفحات المنتجات',
        'Change the instalment line on product pages'
      ),
      rows,
      affectedCount: 1,
      restore: instToArgs(cur),
      touchesCheckout: true,
    };
  },
  run: (ctx, a, st) => {
    const cur = ((st as { instalments: Rec | null }).instalments ?? null) as Rec | null;
    return StoreService.update(ctx.storeId, {
      settings: { instalments: nextInstalments(cur, a) },
    } as never);
  },
  inverse: (_a, restore) =>
    restore ? { tool: 'instalments_settings', args: restore as Rec } : null,
});

/** Wave 2 (plan 4 C2): payment tools. */
export function paymentsTools(): ToolSpec[] {
  return [codSettings, instalmentsSettings];
}
