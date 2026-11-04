/**
 * Bilingual error bodies (BE:E-2/E-3/E-7, contract T1 -> admin `ERROR_AR`).
 *
 * The admin shows `details.messageAr` / `details.messageEn` when the API sends them and falls back to its own code -> Arabic map
 * otherwise. Plan-gate errors already carry both (middleware/feature-gate.ts). RATE_LIMITED, VALIDATION_ERROR and the Multer
 * text did not, so a merchant read raw English in an Arabic admin. One table, three callers; Egyptian Arabic, Western digits.
 */
import type { NextFunction, Request, Response } from 'express';

export interface BilingualMessage {
  messageAr: string;
  messageEn: string;
}

export const RATE_LIMITED_MESSAGE: BilingualMessage = {
  messageAr: 'طلبات كتير في وقت قصير. استنى شوية وجرّب تاني.',
  messageEn: 'Too many requests in a short time. Wait a moment and try again.',
};

export const VALIDATION_ERROR_MESSAGE: BilingualMessage = {
  messageAr: 'في بيانات مش مظبوطة. راجع الحقول وجرّب تاني.',
  messageEn: 'Some of the data is not valid. Check the fields and try again.',
};

export const UPLOAD_ERROR_MESSAGES: Record<string, BilingualMessage> = {
  FILE_TOO_LARGE: {
    messageAr: 'الملف أكبر من الحجم المسموح. صغّره وجرّب تاني.',
    messageEn: 'The file is larger than the allowed size. Make it smaller and try again.',
  },
  LIMIT_UNEXPECTED_FILE: {
    messageAr: 'الملف ده مش في المكان المتوقع. اختار الملف من جديد.',
    messageEn: 'The file was not sent in the expected field. Choose it again.',
  },
  LIMIT_FILE_COUNT: {
    messageAr: 'عدد الملفات أكتر من المسموح. قلّل عدد الملفات.',
    messageEn: 'Too many files. Send fewer files.',
  },
};
export const UPLOAD_ERROR_FALLBACK: BilingualMessage = {
  messageAr: 'مقدرناش نرفع الملف. جرّب تاني.',
  messageEn: 'The file could not be uploaded. Try again.',
};

/**
 * `res.json` hook: any body whose `error.code` is RATE_LIMITED gets the bilingual `details`, wherever it was produced (the global
 * limiter in app.ts and ~40 limiter bodies in middleware/security.ts, public-read-limit.ts, contact-enquiry-limiters.ts).
 * A body that already carries `details.messageAr` is left alone.
 */
export function localizeRateLimited(_req: Request, res: Response, next: NextFunction): void {
  const json = res.json.bind(res);
  res.json = ((body: unknown) => {
    const err = (body as { error?: { code?: unknown; details?: Record<string, unknown> } } | null)
      ?.error;
    if (err && typeof err === 'object' && err.code === 'RATE_LIMITED' && !err.details?.messageAr) {
      err.details = { ...(err.details ?? {}), ...RATE_LIMITED_MESSAGE };
    }
    return json(body);
  }) as Response['json'];
  next();
}
