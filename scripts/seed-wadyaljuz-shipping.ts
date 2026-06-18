/**
 * Wady Aljuz — per-area shipping fee seed
 * =========================================
 * Idempotent upsert of ShippingAreaRate rows for store
 * dfc1c208-1c30-4eba-9821-6f3be15e3506 (Wady Aljuz).
 *
 * EDITABLE SEEDS: fees below were transcribed from the merchant's handwritten
 * rate sheets. The merchant adjusts them at any time via Admin → Settings →
 * Shipping → "Delivery areas & fees". This script is a one-time bootstrap
 * only; re-running it is safe (upsert is keyed on storeId + governorate + area).
 *
 * Fees are in FILS (KWD × 1000). 1 KWD = 1000 fils.
 *
 * Usage (from repo root, with apps/api/.env providing DATABASE_URL):
 *   npx tsx scripts/seed-wadyaljuz-shipping.ts
 */

import { prisma } from '@force/database';
import { KUWAIT_GOVERNORATES } from '@force/shared';

const TARGET_STORE_ID = 'dfc1c208-1c30-4eba-9821-6f3be15e3506';

/** Raw seed entries: [governorateEn, areaEn, deliveryFeeInFils] */
const SEED_ENTRIES: [string, string, number][] = [
  // Capital — العاصمة
  ['Capital', 'Dasma', 1500],
  ['Capital', 'Daiya', 1500],
  ['Capital', 'Faiha', 1500],
  ['Capital', 'Rawda', 1500],
  ['Capital', 'Khaldiya', 1500],
  ['Capital', 'Yarmouk', 1500],
  ['Capital', 'Qortuba', 2000],
  ['Capital', 'Abdullah Al-Salem', 1500],
  ['Capital', 'Shaab', 1500],
  ['Capital', 'Surra', 1500],
  ['Capital', 'Kaifan', 2000],
  ['Capital', 'Sulaibikhat', 3000],
  ['Capital', 'Qairawan', 3000],

  // Hawalli — حولي
  ['Hawalli', 'Hawalli', 1000],
  ['Hawalli', 'Salmiya', 1500],
  ['Hawalli', 'Rumaithiya', 1500],
  ['Hawalli', 'Jabriya', 1500],
  ['Hawalli', 'Bayan', 1500],
  ['Hawalli', 'Mishref', 1500],
  ['Hawalli', 'Salwa', 1500],
  ['Hawalli', 'Maidan Hawalli', 1500],
  ['Hawalli', 'Shuhada', 1500],
  ['Hawalli', 'Salam', 1500],
  ['Hawalli', 'Zahra', 1500],
  ['Hawalli', 'Hitteen', 2000],

  // Farwaniya — الفروانية
  ['Farwaniya', 'Farwaniya', 2000],
  ['Farwaniya', 'Khaitan', 2000],
  ['Farwaniya', 'Omariya', 1500],
  ['Farwaniya', 'Ardiya', 2500],
  ['Farwaniya', 'Sabah Al-Nasser', 2000],
  ['Farwaniya', 'Rehab', 2000],
  ['Farwaniya', 'Abdullah Al-Mubarak', 2500],
  ['Farwaniya', 'West Abdullah Al-Mubarak', 2000],

  // Mubarak Al-Kabeer — مبارك الكبير
  ['Mubarak Al-Kabeer', 'Mubarak Al-Kabeer', 2000],
  ['Mubarak Al-Kabeer', 'Sabah Al-Salem', 1500],
  ['Mubarak Al-Kabeer', 'Al-Qusour', 1500],
  ['Mubarak Al-Kabeer', 'Al-Qurain', 2000],
  ['Mubarak Al-Kabeer', 'Abu Ftaira', 2000],
  ['Mubarak Al-Kabeer', 'Messila', 2000],
  ['Mubarak Al-Kabeer', 'Al-Masayel', 1500],
  ['Mubarak Al-Kabeer', 'Al-Fnaitees', 1500],

  // Ahmadi — الأحمدي
  ['Ahmadi', 'Fahaheel', 2500],
  ['Ahmadi', 'Mangaf', 2500],
  ['Ahmadi', 'Fintas', 2000],
  ['Ahmadi', 'Hadiya', 2000],
  ['Ahmadi', 'Jaber Al-Ali', 2500],
  ['Ahmadi', 'Umm Al-Haiman', 2500],
  ['Ahmadi', 'Khairan', 4000],
  ['Ahmadi', 'Magwa', 2000],

  // Jahra — الجهراء
  ['Jahra', 'Jahra', 3000],
  ['Jahra', 'Naeem', 3500],
  ['Jahra', 'Saad Al-Abdullah', 3000],
  ['Jahra', 'Sulaibiya Residential', 3000],
];

async function main() {
  // Guard: refuse to run against a different store id
  const storeId = process.argv[2] ?? TARGET_STORE_ID;
  if (storeId !== TARGET_STORE_ID) {
    console.error(
      `❌ Store id guard failed.\n` +
        `   Expected: ${TARGET_STORE_ID}\n` +
        `   Received: ${storeId}\n` +
        `   This script is scoped to Wady Aljuz only. Exiting without changes.`
    );
    process.exit(1);
  }

  // Build a lookup map from the canonical dataset
  const lookup = new Map<string, { governorateAr: string; areaAr: string; governorate: string }>();
  for (const gov of KUWAIT_GOVERNORATES) {
    for (const area of gov.areas) {
      lookup.set(`${gov.en}::${area.en}`, {
        governorate: gov.en,
        governorateAr: gov.ar,
        areaAr: area.ar,
      });
    }
  }

  let upserted = 0;
  let skipped = 0;

  for (const [governorateEn, areaEn, deliveryFee] of SEED_ENTRIES) {
    const key = `${governorateEn}::${areaEn}`;
    const resolved = lookup.get(key);

    if (!resolved) {
      console.warn(
        `⚠️  SKIP — could not resolve "${areaEn}" in governorate "${governorateEn}" ` +
          `(not found in KUWAIT_GOVERNORATES dataset)`
      );
      skipped++;
      continue;
    }

    await prisma.shippingAreaRate.upsert({
      where: {
        storeId_governorate_area: {
          storeId,
          governorate: resolved.governorate,
          area: areaEn,
        },
      },
      update: {
        governorateAr: resolved.governorateAr,
        areaAr: resolved.areaAr,
        deliveryFee,
        isActive: true,
      },
      create: {
        storeId,
        governorate: resolved.governorate,
        governorateAr: resolved.governorateAr,
        area: areaEn,
        areaAr: resolved.areaAr,
        deliveryFee,
        isActive: true,
      },
    });

    upserted++;
  }

  console.log(
    `\n✅ Done — ${upserted} upserted, ${skipped} skipped (unresolved).\n` +
      `   Store: ${storeId}\n`
  );
}

main()
  .catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
