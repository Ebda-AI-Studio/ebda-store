import { BARCODE_DISPLAY_PX } from '@ebda/shared';
import { config } from '../config';
import logger from '../lib/logger';
import { renderBarcodePng } from '../lib/barcode-png/render';
import { barcodeObjectKey } from '../lib/barcode-png/key';
import { StorageService } from './storage.service';

export interface EmailBarcodeImage {
  url: string;
  /** Size the email shows it at (CSS px); the file itself is 2x. */
  width: number;
  height: number;
}

/**
 * Render the order/payment barcode as a PNG, store it in R2 under a store-scoped
 * keyed name and return what an email needs to reference it. Called from the
 * post-commit Inngest fanout (the email send step), never from a request.
 *
 * NEVER throws and never holds the email: storage off, `off` shape, a number
 * Code 128 cannot carry, an R2 failure or the time budget all return null and
 * the email goes out with the number as text only.
 */
export async function ensureEmailBarcode(args: {
  storeId: string;
  kind: 'order' | 'billing';
  number: string;
  shape: string;
  timeoutMs?: number;
}): Promise<EmailBarcodeImage | null> {
  if (args.shape === 'off') return null;
  const work = (async (): Promise<EmailBarcodeImage | null> => {
    if (!StorageService.isAvailable()) return null;
    const img = renderBarcodePng({ value: args.number, shape: args.shape });
    const key = barcodeObjectKey(config.jwtSecret, args.storeId, args.kind, args.number, img.shape);
    await StorageService.putDerived(key, img.png, 'image/png');
    const url = StorageService.getPublicUrl(key);
    if (!/^https:\/\//i.test(url)) return null;
    const width = BARCODE_DISPLAY_PX.email;
    return { url, width, height: Math.round((width * img.height) / img.width) };
  })();
  const budget = new Promise<null>(resolve =>
    setTimeout(() => resolve(null), args.timeoutMs ?? 8000)
  );
  try {
    const out = await Promise.race([work, budget]);
    if (!out) work.catch(() => undefined); // a late failure must not become an unhandled rejection
    return out;
  } catch (err) {
    logger.warn(
      { err, kind: args.kind, storeId: args.storeId },
      'email barcode: render/upload failed, sending text only'
    );
    return null;
  }
}
