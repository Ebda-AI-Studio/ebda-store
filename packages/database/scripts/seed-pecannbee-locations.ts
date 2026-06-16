/**
 * One-off seed of pecannbee's physical branches into the StoreLocation table,
 * and flips on `store.locationsEnabled`. Idempotent: upserts by [storeId, name].
 *
 * Reads the captured export at
 *   ~/Downloads/pecannbee-migration/locations-page/locations.json
 * Run against prod (post-deploy) with the prod DATABASE_URL set:
 *   npx tsx packages/database/scripts/seed-pecannbee-locations.ts
 *
 * Cross-tenant write — runs as neondb_owner (rolbypassrls) so it is not blocked
 * by the store_locations tenant RLS policy.
 */
import { prisma } from '@force/database';
import fs from 'fs';
import os from 'os';
import path from 'path';

const STORE_ID = '359afc1f-ea5b-4f8d-b372-c038c6c057f7';

interface SeedLocation {
  country: string;
  name: string;
  address: string;
  mapsSearch?: string;
  mapsEmbed?: string;
}
interface SeedFile {
  contacts?: { email?: string; phones?: { kuwait?: string; uae?: string; general?: string } };
  social?: { whatsapp?: string };
  locations: SeedLocation[];
}

function whatsappDigits(raw?: string): string | undefined {
  if (!raw) return undefined;
  const digits = raw.replace(/[^0-9]/g, '');
  return digits.length ? digits : undefined;
}

async function main() {
  const file = path.join(
    os.homedir(),
    'Downloads/pecannbee-migration/locations-page/locations.json'
  );
  const data: SeedFile = JSON.parse(fs.readFileSync(file, 'utf8'));

  await prisma.store.update({
    where: { id: STORE_ID },
    data: { locationsEnabled: true },
  });

  // Phone per country where known, falling back to the general line.
  const phones = data.contacts?.phones ?? {};
  const generalPhone = phones.general;
  const generalWa = whatsappDigits(data.social?.whatsapp ?? phones.general);

  let created = 0;
  let updated = 0;
  for (let i = 0; i < data.locations.length; i++) {
    const l = data.locations[i];
    const isUae = /u\.?a\.?e|emirat/i.test(l.country);
    const phone = isUae ? (phones.uae ?? generalPhone) : (phones.kuwait ?? generalPhone);
    const payload = {
      storeId: STORE_ID,
      name: l.name,
      country: l.country,
      address: l.address,
      mapsUrl: l.mapsSearch,
      mapsEmbedUrl: l.mapsEmbed,
      phone,
      whatsapp: whatsappDigits(phone) ?? generalWa,
      position: i,
      isPublished: true,
    };

    const existing = await prisma.storeLocation.findFirst({
      where: { storeId: STORE_ID, name: l.name },
      select: { id: true },
    });
    if (existing) {
      await prisma.storeLocation.update({ where: { id: existing.id }, data: payload });
      updated++;
    } else {
      await prisma.storeLocation.create({ data: payload });
      created++;
    }
  }

  console.log(
    `seeded pecannbee locations: ${created} created, ${updated} updated (${data.locations.length} total); locationsEnabled=true`
  );
}

main()
  .catch(err => {
    console.error('seed failed:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
