/**
 * Deterministic fixture, written as plain SQL so it is byte-identical for both
 * refs (independent of either ref's Prisma client). Every id is a stable
 * name-derived UUID, so the snapshot can print `<seed:...>` instead of a
 * random id and the two refs line up row for row.
 *
 * Only columns that exist at the baseline (96814545) are written; newer
 * columns take their migration defaults. If a future migration adds a NOT NULL
 * column WITHOUT a default to one of these tables, seeding fails loudly — that
 * is itself a schema change the owner must hear about.
 */
import crypto from 'node:crypto';

export const OWNER_EMAIL = 'owner@bfp-parity.test';
export const OWNER_PASSWORD = 'BfpOwner!Parity2026';
// bcryptjs.hashSync(OWNER_PASSWORD, 10) — precomputed so the fixture needs no deps.
// nosemgrep: generic.secrets.security.detected-bcrypt-hash.detected-bcrypt-hash -- hash of the throwaway local-harness password above, only ever seeded into a disposable local database
const OWNER_HASH = '$2b$10$YZe6BZQ1L6DcDfyLDvHQLOXyy9PqCJ1Ml.fS6JBxcdoaNwOo0nEQi';

export const MF_API_KEY = 'bfp-parity-myfatoorah-api-key';
export const MF_WEBHOOK_SECRET = 'bfp-parity-myfatoorah-webhook-secret';
export const COD_FEE = 500; // piastres (5.00 EGP)
export const VAT_RATE = '14.00';

/** Name-derived UUID (v5-shaped). Stable across runs, refs and machines. */
export function sid(name) {
  const h = crypto.createHash('sha1').update(`bfp:${name}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Mirror of apps/api/src/services/encryption.service.ts encrypt(). */
export function encryptSecret(plaintext, encryptionKey) {
  const key = crypto.createHash('sha256').update(encryptionKey).digest();
  const iv = crypto.randomBytes(16);
  const salt = crypto.randomBytes(32);
  const derived = crypto.pbkdf2Sync(key, salt, 10000, 32, 'sha256');
  const cipher = crypto.createCipheriv('aes-256-gcm', derived, iv, { authTagLength: 16 });
  let enc = cipher.update(plaintext, 'utf8', 'hex');
  enc += cipher.final('hex');
  return Buffer.concat([salt, iv, cipher.getAuthTag(), Buffer.from(enc, 'hex')]).toString('base64');
}

const q = v => {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (Array.isArray(v)) return `ARRAY[${v.map(q).join(',')}]::text[]`;
  if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  return `'${String(v).replace(/'/g, "''")}'`;
};

function insert(table, row) {
  const cols = Object.keys(row);
  return `INSERT INTO public.${table} (${cols.map(c => `"${c}"`).join(', ')}) VALUES (${cols
    .map(c => q(row[c]))
    .join(', ')});`;
}

/**
 * Scenario-owned catalogue: every scenario gets its OWN products / coupons so a
 * diff in one scenario can never cascade into another's stock or usage count.
 */
export function buildFixture({ encryptionKey, scenarios }) {
  const sql = [];
  const ids = {}; // placeholder name -> id (for normalisation)
  const reg = (name, id = sid(name)) => ((ids[id] = name), id);
  const ts = '2026-01-01 00:00:00';

  const ownerId = reg('user:owner');
  sql.push(
    insert('users', {
      id: ownerId,
      email: OWNER_EMAIL,
      password_hash: OWNER_HASH,
      first_name: 'Parity',
      last_name: 'Owner',
      role: 'store_admin',
      status: 'active',
      email_verified: true,
      updated_at: ts,
    })
  );

  const stores = {};
  for (const key of ['main', 'vat']) {
    const storeId = reg(`store:${key}`);
    stores[key] = storeId;
    sql.push(
      insert('stores', {
        id: storeId,
        name: `BFP Parity ${key}`,
        slug: `bfp-parity-${key}`,
        owner_id: ownerId,
        status: 'active',
        currency: 'EGP',
        settings: {},
        // The 'vat' store's tax_rates row (below) only actually charges/
        // shows VAT once resolveActiveTaxRate's taxEnabled gate is on too
        // (ruling M3-9) — the 'tax' feature itself is already on by the
        // default 'starter' plan baseline (PLAN_BASELINE.starter includes
        // 'tax'), so this is the one flag this fixture needs to flip.
        ...(key === 'vat' ? { tax_enabled: true } : {}),
        updated_at: ts,
      })
    );
    for (const feature of ['coupons', 'bundles']) {
      sql.push(
        insert('store_features', {
          id: reg(`feature:${key}:${feature}`),
          store_id: storeId,
          feature_key: feature,
          enabled: true,
          updated_at: ts,
        })
      );
    }
    sql.push(
      insert('payment_configs', {
        id: reg(`paycfg:${key}:myfatoorah`),
        store_id: storeId,
        provider: 'myfatoorah',
        is_enabled: true,
        is_default: true,
        display_name: 'MyFatoorah',
        api_key: encryptSecret(MF_API_KEY, encryptionKey),
        webhook_secret: encryptSecret(MF_WEBHOOK_SECRET, encryptionKey),
        test_mode: true,
        supported_methods: ['visa', 'mastercard'],
        supported_currencies: ['EGP'],
        updated_at: ts,
      })
    );
    sql.push(
      insert('payment_configs', {
        id: reg(`paycfg:${key}:cod`),
        store_id: storeId,
        provider: 'cod',
        is_enabled: true,
        is_default: false,
        display_name: 'Cash on Delivery',
        fixed_fee: COD_FEE,
        updated_at: ts,
      })
    );
    // Egypt per-area delivery rates, in piastres (15.00 / 20.00 EGP; free over 400.00 EGP).
    const rates = [
      ['Cairo', 'القاهرة', 'Nasr City', 'مدينة نصر', 1500, 40000],
      ['Giza', 'الجيزة', 'Dokki', 'الدقي', 2000, null],
    ];
    for (const [gov, govAr, area, areaAr, fee, free] of rates) {
      sql.push(
        insert('shipping_area_rates', {
          id: reg(`rate:${key}:${area}`),
          store_id: storeId,
          country: 'Egypt',
          country_ar: 'مصر',
          governorate: gov,
          governorate_ar: govAr,
          area,
          area_ar: areaAr,
          delivery_fee: fee,
          free_shipping_threshold: free,
          is_active: true,
          updated_at: ts,
        })
      );
    }
  }
  sql.push(
    insert('tax_rates', {
      id: reg('tax:vat:vat'),
      store_id: stores.vat,
      name: 'VAT',
      rate: VAT_RATE,
      is_active: true,
      updated_at: ts,
    })
  );

  const catalog = {};
  scenarios.forEach((sc, idx) => {
    const store = stores[sc.store ?? 'main'];
    const s = (catalog[sc.id] = {
      storeId: store,
      products: {},
      variants: {},
      coupons: {},
      bundles: {},
    });
    for (const [pkey, p] of Object.entries(sc.fixture?.products ?? {})) {
      const productId = reg(`product:${sc.id}:${pkey}`);
      s.products[pkey] = productId;
      sql.push(
        insert('products', {
          id: productId,
          store_id: store,
          name: `${sc.id} ${pkey}`,
          slug: `s${idx}-${pkey}`,
          price: p.price,
          cost_price: p.costPrice ?? Math.round(p.price / 2),
          sku: `S${idx}-${pkey}`.toUpperCase(),
          inventory: p.inventory,
          track_inventory: p.trackInventory ?? true,
          status: 'active',
          has_variants: !!p.variants,
          updated_at: ts,
        })
      );
      if (p.variants) {
        const optionId = reg(`option:${sc.id}:${pkey}:size`);
        sql.push(
          insert('product_options', {
            id: optionId,
            product_id: productId,
            name: 'Size',
            position: 0,
          })
        );
        Object.entries(p.variants).forEach(([vkey, v], vi) => {
          const valueId = reg(`optval:${sc.id}:${pkey}:${vkey}`);
          const variantId = reg(`variant:${sc.id}:${pkey}:${vkey}`);
          s.variants[`${pkey}:${vkey}`] = variantId;
          sql.push(
            insert('product_option_values', {
              id: valueId,
              option_id: optionId,
              value: vkey,
              position: vi,
            })
          );
          sql.push(
            insert('product_variants', {
              id: variantId,
              product_id: productId,
              title: vkey,
              sku: `S${idx}-${pkey}-${vkey}`.toUpperCase(),
              price: v.price ?? null,
              cost_price: v.costPrice ?? null,
              inventory: v.inventory,
              position: vi,
              is_active: true,
              updated_at: ts,
            })
          );
          sql.push(insert('product_variant_options', { variant_id: variantId, value_id: valueId }));
        });
      }
    }
    for (const [ckey, c] of Object.entries(sc.fixture?.coupons ?? {})) {
      const couponId = reg(`coupon:${sc.id}:${ckey}`);
      const code = `S${idx}${ckey}`.toUpperCase();
      s.coupons[ckey] = { id: couponId, code };
      sql.push(
        insert('coupons', {
          id: couponId,
          store_id: store,
          code,
          name: `${sc.id} ${ckey}`,
          type: c.type,
          value: c.value,
          min_order_amount: c.minOrderAmount ?? null,
          max_discount: c.maxDiscount ?? null,
          usage_limit: c.usageLimit ?? null,
          usage_count: 0,
          is_active: true,
          updated_at: ts,
        })
      );
    }
    for (const [bkey, b] of Object.entries(sc.fixture?.bundles ?? {})) {
      const bundleId = reg(`bundle:${sc.id}:${bkey}`);
      s.bundles[bkey] = bundleId;
      sql.push(
        insert('bundles', {
          id: bundleId,
          store_id: store,
          name: `${sc.id} ${bkey}`,
          slug: `s${idx}-${bkey}`,
          pricing_type: b.pricingType,
          pricing_value: b.pricingValue,
          is_active: true,
          updated_at: ts,
        })
      );
      for (const item of b.items) {
        sql.push(
          insert('bundle_items', {
            id: reg(`bundleitem:${sc.id}:${bkey}:${item.product}`),
            bundle_id: bundleId,
            product_id: s.products[item.product],
            variant_id: null,
            quantity: item.quantity,
          })
        );
      }
    }
  });

  return { sql: `BEGIN;\n${sql.join('\n')}\nCOMMIT;\n`, ids, stores, catalog, ownerId };
}
