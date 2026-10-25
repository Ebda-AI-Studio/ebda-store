/**
 * First-time shipment facts (CI 1.1/1.2), derived purely from the merged tracking history so they are
 * the same whichever path (poll, webhook, merchant) wins the race:
 *  - `pickedUpAt` / `deliveredAt` / `returnedAt`: the carrier timestamp of the EARLIEST entry in that
 *    state, written only while the column is still null (never overwritten);
 *  - `deliveryAttempts`: how many `failed` entries the history holds;
 *  - on the first `returned`: the scrubbed reason and its closed code (the reason is usually on the
 *    failed attempt just before, so that entry's text is the fallback).
 * `marks` are the occurrences that are NEW in this call; they drive the first-time-only CI events.
 */
import type { HistoryEntry } from '../shipment-tracking';
import { mapReturnReason } from './return-reason';
import type { ShipmentCiMark } from './planner';

export interface ShipmentStampState {
  carrier: string;
  pickedUpAt: Date | null;
  deliveredAt: Date | null;
  returnedAt: Date | null;
  deliveryAttempts: number;
}

export interface ShipmentStampUpdate {
  pickedUpAt?: Date;
  deliveredAt?: Date;
  returnedAt?: Date;
  deliveryAttempts?: number;
  returnReasonRaw?: string | null;
  returnReasonCode?: string;
}

export function shipmentStamps(
  history: HistoryEntry[],
  cur: ShipmentStampState,
  source: 'carrier_poll' | 'carrier_webhook' | 'merchant_manual'
): { data: ShipmentStampUpdate; marks: ShipmentCiMark[] } {
  const data: ShipmentStampUpdate = {};
  const marks: ShipmentCiMark[] = [];
  const sorted = [...history].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );
  // "Updated by the merchant" is not a carrier reason.
  const textOf = (h?: HistoryEntry) =>
    source === 'merchant_manual' ? null : (h?.description ?? null);
  const first = (status: string) => sorted.find(h => h.status === status);

  const picked = first('picked_up');
  if (picked && !cur.pickedUpAt) {
    data.pickedUpAt = new Date(picked.timestamp);
    marks.push({ kind: 'picked_up', at: picked.timestamp });
  }
  const failed = sorted.filter(h => h.status === 'failed');
  if (failed.length > cur.deliveryAttempts) {
    data.deliveryAttempts = failed.length;
    for (let n = cur.deliveryAttempts + 1; n <= failed.length; n++) {
      const h = failed[n - 1]!;
      marks.push({ kind: 'attempted', at: h.timestamp, attemptNo: n, reasonRaw: textOf(h) });
    }
  }
  const delivered = first('delivered');
  if (delivered && !cur.deliveredAt) {
    data.deliveredAt = new Date(delivered.timestamp);
    marks.push({ kind: 'delivered', at: delivered.timestamp });
  }
  const returned = first('returned');
  if (returned && !cur.returnedAt) {
    data.returnedAt = new Date(returned.timestamp);
    const before = failed.filter(f => f.timestamp <= returned.timestamp).at(-1);
    const reason = mapReturnReason(cur.carrier, textOf(returned) ?? textOf(before));
    data.returnReasonRaw = reason.raw;
    data.returnReasonCode = reason.code;
    marks.push({ kind: 'returned', at: returned.timestamp, reasonRaw: reason.raw });
  }
  return { data, marks };
}
