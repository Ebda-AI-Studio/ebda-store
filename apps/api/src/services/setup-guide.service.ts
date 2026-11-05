/**
 * Setup-guide checklist state (SP5 self-serve onboarding).
 *
 * Persisted per store in `stores.settings.setupGuide`:
 *   { manual: { [key]: boolean }, dismissed: boolean }
 * `done` for each item is DERIVED from real store data wherever a reliable
 * signal exists (see SETUP_GUIDE_ITEMS), so the list can never claim a product
 * exists when it does not. Manual ticks cover only items with no data signal
 * (share) or an explicit merchant decision (payment confirmed, domain skipped).
 *
 * Must run inside the store's tenant context (products, orders and shipping
 * zones are RLS-protected): routes mount it behind `tenantContext`; other
 * callers wrap it in `readInStoreContext`.
 */
import { prisma } from '@ebda/database';
import { copyStoreSettings, storeDb, storeUpdate, storeWritesToDo } from '../lib/repo-factory';
import {
  getLook,
  SETUP_GUIDE_ITEMS,
  isSetupGuideKey,
  type SetupGuideKey,
  type SetupGuideState,
} from '@ebda/shared';
import { AppError } from '../middleware/error-handler';

interface StoredGuide {
  manual?: Record<string, boolean>;
  dismissed?: boolean;
}

function readStored(settings: unknown): StoredGuide {
  const raw = (settings as { setupGuide?: unknown } | null)?.setupGuide;
  return raw && typeof raw === 'object' ? (raw as StoredGuide) : {};
}

function hasBrandColor(theme: unknown): boolean {
  const t = theme as { primaryColor?: unknown; primary?: unknown } | null;
  return (
    (typeof t?.primaryColor === 'string' && t.primaryColor.length > 0) ||
    (typeof t?.primary === 'string' && t.primary.length > 0)
  );
}

/**
 * Merge a tick (`manual`) or the dismissed flag into `settings.setupGuide` (N-19). Postgres store: ONE atomic statement (two tabs
 * ticking at once cannot clobber each other) and the DO copy gets the whole RETURNING value. D1 + Durable Object store (no
 * Postgres row): a write-time read-merge through `storeUpdate` with the whole `settings` value. RESIDUAL: two writers within the
 * same few milliseconds on a DO store can interleave and lose one tick (same residual as StoreService.setSettingsKey). Cost if
 * wrong: one checklist tick is lost and the merchant ticks it again.
 */
async function patchGuide(
  storeId: string,
  change: { manual: { key: string; done: boolean } } | { dismissed: boolean }
): Promise<void> {
  if (await storeWritesToDo(storeId)) {
    const row = await storeDb(storeId).then(db =>
      db.store.findUnique({ where: { id: storeId }, select: { settings: true } })
    );
    const live = (row?.settings as Record<string, unknown> | null) ?? {};
    const guide = (live.setupGuide as StoredGuide | undefined) ?? {};
    const next: StoredGuide =
      'manual' in change
        ? { ...guide, manual: { ...(guide.manual ?? {}), [change.manual.key]: change.manual.done } }
        : { ...guide, dismissed: change.dismissed };
    await storeUpdate(prisma, {
      where: { id: storeId },
      data: { settings: { ...live, setupGuide: next } as never },
      select: { id: true },
    });
    return;
  }
  const rows =
    'manual' in change
      ? await prisma.$queryRaw<Array<{ settings: unknown; updatedAt?: Date }>>`
          UPDATE stores SET settings = jsonb_set(
            COALESCE(settings, '{}'::jsonb), '{setupGuide}',
            COALESCE(settings->'setupGuide', '{}'::jsonb) || jsonb_build_object(
              'manual', COALESCE(settings->'setupGuide'->'manual', '{}'::jsonb)
                        || jsonb_build_object(${change.manual.key}::text, ${change.manual.done}::boolean)
            ), true)
          WHERE id = ${storeId}
          RETURNING settings, updated_at AS "updatedAt"`
      : await prisma.$queryRaw<Array<{ settings: unknown; updatedAt?: Date }>>`
          UPDATE stores SET settings = jsonb_set(
            COALESCE(settings, '{}'::jsonb), '{setupGuide}',
            COALESCE(settings->'setupGuide', '{}'::jsonb)
              || jsonb_build_object('dismissed', ${change.dismissed}::boolean), true)
          WHERE id = ${storeId}
          RETURNING settings, updated_at AS "updatedAt"`;
  await copyStoreSettings(storeId, {
    settings: rows?.[0]?.settings ?? {},
    ...(rows?.[0]?.updatedAt instanceof Date ? { updatedAt: rows[0].updatedAt } : {}),
  });
}

export class SetupGuideService {
  static async get(storeId: string): Promise<SetupGuideState> {
    const store = await storeDb(storeId).then(db =>
      db.store.findUnique({
        where: { id: storeId },
        select: { logo: true, theme: true, look: true, domain: true, settings: true },
      })
    );
    if (!store) throw new AppError(404, 'STORE_NOT_FOUND', 'Store not found');

    // the catalogue, zones, orders and gateways live in the store's backend (Durable Object or Postgres)
    const db = await storeDb(storeId);
    const [products, zones, orders, otherMethods] = await Promise.all([
      db.product.count({ where: { storeId, deletedAt: null } }),
      db.shippingZone.count({ where: { storeId, isActive: true } }),
      db.order.count({ where: { storeId } }),
      db.paymentConfig.count({ where: { storeId, isEnabled: true, provider: { not: 'cod' } } }),
    ]);

    const stored = readStored(store.settings);
    const manual = stored.manual ?? {};

    const fromData: Record<SetupGuideKey, boolean> = {
      add_product: products > 0,
      // A look IS a brand palette: a look store has its colours without storing any (LOOKS-14).
      brand: !!store.logo || !!getLook(store.look) || hasBrandColor(store.theme),
      shipping: zones > 0,
      // COD is on by default, so "enabled" alone proves nothing: payment is
      // done when the merchant confirmed it (onboarding step / explicit tick)
      // or has switched on a non-COD gateway.
      payment: otherMethods > 0,
      domain: !!store.domain,
      test_order: orders > 0,
      share: false,
    };

    const items = SETUP_GUIDE_ITEMS.map(def => {
      const data = def.auto ? fromData[def.key] : false;
      const ticked = def.manual && manual[def.key] === true;
      return {
        key: def.key,
        done: data || ticked,
        fromData: data,
        optional: def.optional,
        manual: def.manual,
      };
    });
    const required = items.filter(i => !i.optional);
    return {
      items,
      doneCount: items.filter(i => i.done).length,
      totalCount: items.length,
      requiredDone: required.filter(i => i.done).length,
      requiredTotal: required.length,
      dismissed: stored.dismissed === true,
    };
  }

  /** Tick / untick a manual item. Data-derived-only items are refused. */
  static async setManual(storeId: string, key: string, done: boolean): Promise<SetupGuideState> {
    if (!isSetupGuideKey(key)) throw new AppError(400, 'INVALID_GUIDE_ITEM', 'Unknown guide item');
    const def = SETUP_GUIDE_ITEMS.find(d => d.key === key)!;
    if (!def.manual) {
      throw new AppError(
        400,
        'AUTO_GUIDE_ITEM',
        'This item completes automatically from your data'
      );
    }
    await patchGuide(storeId, { manual: { key, done } });
    return this.get(storeId);
  }

  static async setDismissed(storeId: string, dismissed: boolean): Promise<SetupGuideState> {
    await patchGuide(storeId, { dismissed });
    return this.get(storeId);
  }
}
