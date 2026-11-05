/**
 * NEON-ZERO (Ruling NZ-C-11): the admin push audiences from D1 + the identity service, with no Postgres.
 *
 * Same answer as the SQL definer `ebda_admin_push_player_ids` (store_admin = the owner of the store; super_admin = every
 * super_admin), but `onesignal_subscriptions` and `stores` are D1 (family `ops` / `access`) and the role lives in identity.
 * BOUNDED: the super_admin audience reads at most DEVICE_SCAN_CAP device rows (newest first), so at most
 * DEVICE_SCAN_CAP / 100 identity calls; a device beyond the cap is missed and the caller falls back to tag filtering.
 */
import { d1All } from './billing-d1';
import { getAccountsBrief } from '../../lib/identity-client';

export const DEVICE_SCAN_CAP = 500;

interface Dev {
  user_id: string;
  player_id: string;
}

export async function adminPushPlayerIdsD1(
  role: 'store_admin' | 'super_admin',
  storeId: string | null
): Promise<string[]> {
  if (role === 'store_admin') {
    if (!storeId) return [];
    const devices = await d1All<Dev>(
      `SELECT o.user_id, o.player_id FROM onesignal_subscriptions o
         JOIN stores s ON s.owner_id = o.user_id
        WHERE s.id = ?1 ORDER BY o.updated_at DESC LIMIT ?2`,
      storeId,
      DEVICE_SCAN_CAP
    );
    return pick(devices, 'store_admin');
  }
  const devices = await d1All<Dev>(
    'SELECT user_id, player_id FROM onesignal_subscriptions ORDER BY updated_at DESC LIMIT ?1',
    DEVICE_SCAN_CAP
  );
  return pick(devices, 'super_admin');
}

async function pick(devices: Dev[], role: 'store_admin' | 'super_admin'): Promise<string[]> {
  if (devices.length === 0) return [];
  const briefs = await getAccountsBrief(devices.map(d => d.user_id));
  const ok = new Set(briefs.filter(b => b.role === role).map(b => b.id));
  return [...new Set(devices.filter(d => ok.has(d.user_id)).map(d => d.player_id))];
}
