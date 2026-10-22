import { Router, Request, Response, NextFunction } from 'express';
import { publicLimiter } from '../middleware/security';
import { verifyLifecycleUnsubscribeToken } from '../lib/lifecycle-unsubscribe-token';
import { optOut } from '../services/lifecycle-emails.service';
import { BRAND } from '@ebda/shared';

/**
 * Login-free unsubscribe for the self-serve lifecycle emails. Mounted at `/public/lifecycle-emails`
 * (`/public/` paths skip CSRF).
 *
 *   GET  ?token=...  -> a small confirm page. Mail scanners and link previews prefetch GETs, so a GET
 *                       must never unsubscribe anyone.
 *   POST ?token=...  -> performs it (idempotent) and answers the same page.
 *
 * The store comes from the signed token (campaign-unsubscribe pattern), so all work runs in that
 * store's tenant context. Bilingual, Arabic first; no store data is shown.
 */
const router = Router();

/** The API-wide CSP is `default-src 'none'`: these two tiny pages need their own inline style + the form post. */
const PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
function sendPage(res: Response, html: string, status = 200): void {
  res.status(status).setHeader('Content-Security-Policy', PAGE_CSP);
  res.type('html').send(html);
}

const page = (title: string, body: string, form?: { token: string }): string => `<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${title}</title>
<style>body{margin:0;background:${BRAND.colors.night};color:#f5f1ea;font:16px/1.7 Tahoma,Arial,sans-serif;display:grid;place-items:center;min-height:100vh;padding:24px}
main{max-width:420px;text-align:center}h1{font-size:20px;color:${BRAND.colors.lift}}p{color:#d9d3c7}
button{background:${BRAND.colors.gold};color:${BRAND.colors.night};border:0;border-radius:8px;padding:12px 24px;font:inherit;font-weight:700;cursor:pointer}</style></head>
<body><main><h1>${title}</h1>${body}${
  form
    ? `<form method="post" action="?token=${encodeURIComponent(form.token)}"><button type="submit">إلغاء الاشتراك · Unsubscribe</button></form>`
    : ''
}</main></body></html>`;

function tokenFrom(req: Request): string | undefined {
  return typeof req.query.token === 'string' ? req.query.token : undefined;
}

function invalid(res: Response): void {
  sendPage(
    res,
    page(
      'الرابط مش صالح · Invalid link',
      '<p>الرابط ده مش صالح أو اتعدّل.</p><p>This link is not valid.</p>'
    ),
    404
  );
}

router.get('/unsubscribe', publicLimiter, (req: Request, res: Response) => {
  const token = tokenFrom(req);
  if (!token || !verifyLifecycleUnsubscribeToken(token)) return invalid(res);
  res.setHeader('Cache-Control', 'no-store');
  sendPage(
    res,
    page(
      'إلغاء رسائل البداية · Setup emails',
      '<p>مش هنبعتلك رسائل البداية والتجربة تاني. رسائل الطلبات والفواتير مش هتتأثر.</p><p>We will stop the setup and trial emails. Order and billing emails are not affected.</p>',
      { token }
    )
  );
});

router.post(
  '/unsubscribe',
  publicLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const token = tokenFrom(req);
      const ids = token ? verifyLifecycleUnsubscribeToken(token) : null;
      if (!ids) return invalid(res);
      await optOut(ids.storeId);
      res.setHeader('Cache-Control', 'no-store');
      sendPage(
        res,
        page(
          'تم · Done',
          '<p>تم إلغاء الاشتراك في رسائل البداية والتجربة.</p><p>You are unsubscribed from setup and trial emails.</p>'
        )
      );
    } catch (err) {
      next(err);
    }
  }
);

export default router;
