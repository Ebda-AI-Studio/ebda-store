import { randomUUID } from 'node:crypto';
import express, { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { BRAND_MARKETING_URL } from '@ebda/shared/brand';
import {
  CONTACT_HONEYPOT_FIELD,
  CONTACT_LIMITS,
  CONTACT_MIN_FILL_MS,
  CONTACT_TOPIC_IDS,
  CONTACT_TOPIC_LABELS,
  formatPhoneDisplay,
  normalizeEmail,
  normalizePhone,
  type ContactFieldError,
} from '@ebda/shared/contact-enquiry';
import logger from '../lib/logger';
import { sendAlert } from '../services/alerts.service';
import { EmailService } from '../services/email.service';
import { contactEnquiryLimiters } from '../middleware/contact-enquiry-limiters';

/**
 * Public studio enquiry form, mounted at `/public/contact` (`/public/` paths skip CSRF; the marketing origin is a
 * platform origin so CORS allows the page's fetch). Ruling CONTACT-FORM-1.
 *
 *   POST /enquiry   JSON (the page's fetch) or urlencoded (the form without JavaScript).
 *
 * - Zod at the edge; every field length-capped; phone and email normalised; control characters stripped from
 *   single-line fields (header injection); all output is escaped in the email templates.
 * - Spam: a hidden honeypot field (a bot that fills it gets a fake success and no email), a minimum fill time
 *   (the page sends how long it was open), and 5/hour per IP and per email (middleware/contact-enquiry-limiters).
 * - Delivery: the enquiry goes to the studio inbox by the platform email path, directly and awaited, never queued:
 *   the visitor is told "sent" only after the send resolved. A failed send raises a P1 alert and answers 502.
 * - Nothing is stored. Logs carry a request id and an outcome only, never a name, address, phone or message.
 * - No-JS form posts get a 303 back to a fixed marketing URL (`/contact/#sent` or `#send-failed`), never to a
 *   client-supplied one.
 */
const router = Router();

type Outcome = 'sent' | 'honeypot' | 'invalid' | 'too_fast' | 'send_failed';
function logOutcome(requestId: string, outcome: Outcome): void {
  logger.info({ requestId, outcome }, 'contact.enquiry');
}

const CTRL_ONE_LINE = /[\u0000-\u001f\u007f\u2028\u2029]+/g;
const CTRL_MULTI = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const oneLine = (v: string) => v.replace(CTRL_ONE_LINE, ' ').trim();

const str = (max: number) => z.string().max(max);
const L = CONTACT_LIMITS;

const bodySchema = z.object({
  name: str(L.name).transform(oneLine).pipe(z.string().min(1)),
  company: str(L.company)
    .optional()
    .transform(v => (v ? oneLine(v) : undefined)),
  phone: str(L.phone)
    .transform(v => normalizePhone(v))
    .pipe(z.string({ error: 'invalid_phone' })),
  email: str(L.email)
    .transform(v => normalizeEmail(v))
    .pipe(z.string({ error: 'invalid_email' })),
  topic: z.enum(CONTACT_TOPIC_IDS),
  message: str(L.message)
    .transform(v => v.replace(CTRL_MULTI, '').trim())
    .pipe(z.string().min(L.messageMin)),
  consent: z.union([z.literal(true), z.literal('true'), z.literal('on'), z.literal('1')]),
  lang: z.enum(['ar', 'en']).catch('ar'),
  [CONTACT_HONEYPOT_FIELD]: z.string().max(500).optional(),
  fillMs: z.coerce.number().finite().optional().catch(undefined),
});

/** Map zod issues to field -> stable code. Never echoes user input. */
function fieldErrors(
  error: z.ZodError,
  raw: Record<string, unknown>
): Record<string, ContactFieldError> {
  const out: Record<string, ContactFieldError> = {};
  for (const issue of error.issues) {
    const field = String(issue.path[0] ?? 'form');
    if (out[field]) continue;
    let code: ContactFieldError = 'required';
    const given = raw[field];
    if (given === undefined || given === null || given === '')
      code = field === 'consent' ? 'consent_required' : 'required';
    else if (issue.code === 'too_big') code = 'too_long';
    else if (issue.code === 'too_small') code = field === 'message' ? 'too_short' : 'required';
    else if (field === 'email') code = 'invalid_email';
    else if (field === 'phone') code = 'invalid_phone';
    else if (field === 'topic') code = 'invalid_topic';
    else if (field === 'consent') code = 'consent_required';
    else if (issue.code === 'invalid_type') code = 'required';
    out[field] = code;
  }
  return out;
}

/** A browser form post (no JavaScript) is urlencoded and does not ask for JSON. */
function isPlainFormPost(req: Request): boolean {
  return (
    Boolean(req.is('application/x-www-form-urlencoded')) &&
    !String(req.headers.accept ?? '').includes('application/json')
  );
}

function landingUrl(lang: unknown, anchor: 'sent' | 'send-failed'): string {
  return `${BRAND_MARKETING_URL}${lang === 'en' ? '/en' : ''}/contact/#${anchor}`;
}

function fail(
  req: Request,
  res: Response,
  status: number,
  code: string,
  message: string,
  fields?: Record<string, ContactFieldError>
): void {
  if (isPlainFormPost(req)) {
    res.redirect(303, landingUrl((req.body as { lang?: unknown })?.lang, 'send-failed'));
    return;
  }
  res.setHeader('Cache-Control', 'no-store');
  res
    .status(status)
    .json({ success: false, error: { code, message, ...(fields ? { fields } : {}) } });
}

router.post(
  '/enquiry',
  express.json({ limit: '32kb' }),
  express.urlencoded({ extended: false, limit: '32kb', parameterLimit: 40 }),
  contactEnquiryLimiters.ip,
  contactEnquiryLimiters.email,
  async (req: Request, res: Response) => {
    const requestId = randomUUID();
    const parsed = bodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      logOutcome(requestId, 'invalid');
      return fail(
        req,
        res,
        400,
        'VALIDATION_ERROR',
        'Some fields need fixing.',
        fieldErrors(parsed.error, (req.body ?? {}) as Record<string, unknown>)
      );
    }
    const d = parsed.data;

    // A bot filled the field no person sees: answer like a success, send nothing.
    if (d[CONTACT_HONEYPOT_FIELD]) {
      logOutcome(requestId, 'honeypot');
      return respondSent(req, res, requestId, d.lang);
    }
    // The page reports how long it was open; a human cannot fill the form in under a couple of seconds.
    if (d.fillMs !== undefined && d.fillMs < CONTACT_MIN_FILL_MS) {
      logOutcome(requestId, 'too_fast');
      return fail(req, res, 400, 'TOO_FAST', 'Please wait a moment and send again.');
    }

    const topicLabel = CONTACT_TOPIC_LABELS[d.topic].en;
    try {
      await EmailService.sendContactEnquiry({
        requestId,
        name: d.name,
        company: d.company,
        phone: d.phone,
        phoneDisplay: formatPhoneDisplay(d.phone),
        email: d.email,
        topicLabel,
        message: d.message,
        lang: d.lang,
      });
    } catch (err) {
      logOutcome(requestId, 'send_failed');
      // No visitor data in the alert: the reference and the error class only.
      await sendAlert({
        level: 'p1',
        source: 'public.contact.enquiry',
        title: 'Studio enquiry email failed',
        body: 'A visitor tried to send a /contact enquiry and the email send failed. They were told to use WhatsApp or email.',
        context: { requestId, error: err instanceof Error ? err.name : 'unknown' },
      });
      return fail(
        req,
        res,
        502,
        'SEND_FAILED',
        'We could not send your message. Please use WhatsApp or email us instead.'
      );
    }

    // The receipt is a courtesy: its failure never turns a delivered enquiry into an error.
    try {
      await EmailService.sendContactEnquiryReceipt(d.email, {
        name: d.name,
        requestId,
        lang: d.lang,
      });
    } catch {
      logger.warn({ requestId }, 'contact.enquiry.receipt_failed');
    }
    logOutcome(requestId, 'sent');
    return respondSent(req, res, requestId, d.lang);
  }
);

function respondSent(req: Request, res: Response, requestId: string, lang: string): void {
  if (isPlainFormPost(req)) {
    res.redirect(303, landingUrl(lang, 'sent'));
    return;
  }
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ success: true, data: { requestId } });
}

export default router;
