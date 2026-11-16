import { storeDb, storeWriter } from '../../lib/repo-factory';

const FX_SELECT = {
  id: true,
  currency: true,
  rate: true,
  rateDate: true,
  createdAt: true,
} as const;

/** Records one FX rate entry (1 unit of `currency` = `rate` EGP). Shared by `POST /finance/fx-rates` and the assistant's fx_rate_set. */
export async function recordFxRate(
  storeId: string,
  input: { currency: string; rate: number; rateDate: Date; recordedBy: string | null }
) {
  const w = await storeWriter(storeId);
  return w.fxRateEntry.create({
    data: {
      storeId,
      currency: input.currency.toUpperCase(),
      rate: input.rate,
      rateDate: input.rateDate,
      recordedBy: input.recordedBy,
    },
    select: FX_SELECT,
  });
}

/** The most recent rate entry of a currency in this store, or null. */
export async function latestFxRate(storeId: string, currency: string) {
  const db = await storeDb(storeId);
  return db.fxRateEntry.findFirst({
    where: { storeId, currency: currency.toUpperCase() },
    orderBy: [{ rateDate: 'desc' }, { createdAt: 'desc' }],
    select: FX_SELECT,
  });
}
