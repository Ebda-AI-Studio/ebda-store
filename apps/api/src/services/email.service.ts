import { prisma } from '@force/database';
import { config } from '../config';
import { ResendService } from './resend.service';
// Static import is safe despite the email-queue↔email-service cycle: both sides
// use the other only at call-time (sendForStore / the queue's drain), never at
// module load, so ES live-bindings resolve it. `queue: true` routes order emails
// through the durable Redis retry queue (E2-5).
import { emailQueue } from './email-queue.service';
import { welcomeTemplate } from './email-templates/welcome';
import { passwordResetTemplate } from './email-templates/password-reset';
import { emailVerificationTemplate } from './email-templates/email-verification';
import { resendVerificationTemplate } from './email-templates/resend-verification';
import { duplicateRegistrationTemplate } from './email-templates/duplicate-registration';
import { orderConfirmationTemplate } from './email-templates/order-confirmation';
import { orderRefundedTemplate } from './email-templates/order-refunded';
import { paymentSuccessTemplate } from './email-templates/payment-success';
import { paymentFailedTemplate } from './email-templates/payment-failed';
import { orderShippedTemplate } from './email-templates/order-shipped';
import { returnConfirmationTemplate } from './email-templates/return-confirmation';
import { returnStatusUpdateTemplate } from './email-templates/return-status-update';
import { reviewRequestTemplate, type ReviewRequestData } from './email-templates/review-request';
import { lowStockAlertTemplate, type LowStockAlertItem } from './email-templates/low-stock-alert';

// ==========================================
// Email Service
// Transactional email handling
// ==========================================

/**
 * Escape user-supplied strings before they land in transactional HTML
 * email bodies. Customer-controlled values (firstName, address1, item
 * names, coupon codes, etc.) used to be templated directly into HTML —
 * a hostile customer could register with a name like
 * `<script>fetch('//evil')</script>` and have it rendered inside the
 * merchant's order-confirmation inbox view, or worse, put a clickable
 * phishing link into a "Refund Processed" email that the merchant
 * forwards to support. Always pipe untrusted text through this before
 * interpolating into `${...}` blocks in the templates below.
 *
 * `&` must come first so we don't double-encode the `&amp;` we just
 * produced for `<` / `>` / `"`.
 */
function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface EmailOptions {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
}

export interface EmailStoreContext {
  name: string;
  nameAr?: string | null;
  logo?: string | null;
  // Theme JSON stored on Store. Uses `primaryColor` in HSL-component format
  // (e.g. "348 68% 25%") to match the storefront token system. Accepts
  // legacy `primary` too so old admin payloads don't silently fall back.
  theme?: { primaryColor?: string | null; primary?: string | null } | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  defaultLanguage?: 'en' | 'ar';
}

// Derive a low-alpha tint of the brand color for soft header backdrops.
// Emits hsla() for HSL components, rgba() for hex inputs — keeps email
// client compatibility (no color-mix() dependency).
function brandTint(rawColor: string | null | undefined, alpha = 0.06): string {
  if (!rawColor) return 'rgba(15,23,42,0.04)';
  const hslComp = /^([0-9.]+)\s+([0-9.]+)%\s+([0-9.]+)%(?:\s*\/\s*[0-9.]+%?)?$/.exec(
    rawColor.trim()
  );
  if (hslComp) return `hsla(${hslComp[1]} ${hslComp[2]}% ${hslComp[3]}% / ${alpha})`;
  const hex = /^#([0-9a-fA-F]{6})$/.exec(rawColor.trim());
  if (hex) {
    const r = parseInt(hex[1].slice(0, 2), 16);
    const g = parseInt(hex[1].slice(2, 4), 16);
    const b = parseInt(hex[1].slice(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
  return 'rgba(15,23,42,0.04)';
}

// Validate theme primary color (HSL components or hex). Mirrors the
// `sanitizeThemeColor` helper in apps/web/src/app/layout.tsx so admin-
// controlled theme strings can't break out of the CSS declaration.
function sanitizeThemeColor(value: string | null | undefined, fallback = '#ff6e00'): string {
  if (!value || typeof value !== 'string' || value.length === 0 || value.length > 50) {
    return fallback;
  }
  if (/[{}]|url\s*\(|@import|expression\s*\(|javascript\s*:/i.test(value)) return fallback;
  if (/^#[0-9a-fA-F]{3,8}$/.test(value)) return value;
  const hsl =
    /^[0-9]+(?:\.[0-9]+)?\s+[0-9]+(?:\.[0-9]+)?%\s+[0-9]+(?:\.[0-9]+)?%(?:\s*\/\s*[0-9]+(?:\.[0-9]+)?%?)?$/;
  if (hsl.test(value)) return `hsl(${value})`;
  return fallback;
}

export function renderBrandedShell(content: string, store: EmailStoreContext): string {
  const isArabic = store.defaultLanguage === 'ar';
  const dir = isArabic ? 'rtl' : 'ltr';
  // Prefer canonical `primaryColor` token; fall back to legacy `primary` for
  // any old admin payloads that pre-date the rename.
  const rawBrand = store.theme?.primaryColor ?? store.theme?.primary ?? null;
  const brand = sanitizeThemeColor(rawBrand);
  const brandSoft = brandTint(rawBrand, 0.06);
  const storeName = escapeHtml(store.name);
  // Logo OR name — never both. When a logo is set it's the brand mark;
  // rendering the name underneath duplicates the visual identity.
  const header = store.logo
    ? `<img src="${escapeHtml(store.logo)}" alt="${storeName}" class="store-logo">`
    : `<div class="store-name">${storeName}</div>`;
  const year = new Date().getFullYear();
  const footerLines: string[] = [];
  if (store.address) footerLines.push(escapeHtml(store.address));
  if (store.phone) {
    const safePhone = escapeHtml(store.phone);
    // Strip non-digit chars from tel: target so it dials correctly on mobile
    // while keeping the formatted version visible to readers.
    const dial = store.phone.replace(/[^+\d]/g, '');
    footerLines.push(
      `<a href="tel:${escapeHtml(
        dial
      )}" style="color: var(--ink-soft); text-decoration: none;">${safePhone}</a>`
    );
  }
  // Contact line — replaces the per-template "please reply to this email"
  // sentence so every branded email has a canonical reachable contact.
  const contactBlock = store.email
    ? `<p class="contact-cta">Questions? Email us at <a href="mailto:${escapeHtml(
        store.email
      )}" style="color: var(--brand); text-decoration: none; font-weight: 600;">${escapeHtml(
        store.email
      )}</a></p>`
    : '';

  return `<!DOCTYPE html>
<html dir="${dir}" lang="${isArabic ? 'ar' : 'en'}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${storeName}</title>
  <style>
    :root {
      --brand: ${brand};
      --brand-soft: ${brandSoft};
      --ink: #0f172a;
      --ink-soft: #475569;
      --ink-mute: #94a3b8;
      --line: #e2e8f0;
      --line-soft: #f1f5f9;
      --bg: #ffffff;
      --bg-soft: #f8fafc;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0; padding: 24px 12px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      background: var(--bg-soft);
      color: var(--ink);
      line-height: 1.5;
      font-size: 14px;
      -webkit-font-smoothing: antialiased;
    }
    .page {
      max-width: 640px;
      margin: 0 auto;
      background: var(--bg);
      border-radius: 16px;
      overflow: hidden;
      box-shadow: 0 1px 3px rgba(0,0,0,0.04), 0 8px 24px rgba(15,23,42,0.06);
    }
    .ribbon { height: 6px; background: var(--brand); }
    .header {
      padding: 20px 28px 18px;
      text-align: center;
      background: linear-gradient(180deg, var(--brand-soft) 0%, transparent 100%);
      border-bottom: 1px solid var(--line-soft);
    }
    /* Email clients show ~350-400px of vertical space before the fold. A 180px
       logo plus 72px of header padding ate almost all of it, so a merchant
       opening a new-order alert saw branding and had to scroll to reach the
       order. 56px is the usual email-header logo height; width is capped only
       so a very wide wordmark cannot re-inflate the header. height/width auto
       keeps the aspect ratio for any logo shape. */
    .store-logo { max-height: 56px; max-width: 220px; display: inline-block; height: auto; width: auto; }
    .store-name { font-size: 22px; font-weight: 700; color: var(--ink); letter-spacing: -0.01em; }
    .content { padding: 28px 28px 8px; }
    .content h1, .content h2 { color: var(--ink); margin: 0 0 14px; }
    .content h1 { font-size: 22px; }
    .content h2 { font-size: 18px; }
    .content h3 { font-size: 16px; margin: 22px 0 10px; color: var(--ink); }
    .content p { margin: 0 0 14px; color: var(--ink-soft); }
    .content a { color: var(--brand); }
    .button {
      display: inline-block;
      background: var(--brand); color: #ffffff !important;
      padding: 12px 22px; text-decoration: none;
      border-radius: 10px; font-weight: 600; font-size: 14px;
      margin: 8px 0;
    }
    .order-table { width: 100%; border-collapse: collapse; margin: 18px 0; font-size: 13px; }
    .order-table th, .order-table td { padding: 12px 10px; text-align: start; border-bottom: 1px solid var(--line-soft); color: var(--ink); }
    .order-table th { background: var(--bg-soft); font-weight: 600; color: var(--ink-soft); text-transform: uppercase; font-size: 11px; letter-spacing: 0.04em; }
    .total-row { font-weight: 700; font-size: 16px; }
    .total-row td { border-top: 2px solid var(--line); border-bottom: 0; padding-top: 14px; }
    .address-box { background: var(--bg-soft); padding: 16px 18px; border-radius: 12px; margin: 14px 0; color: var(--ink-soft); }
    .footer {
      padding: 22px 28px 28px;
      background: var(--bg-soft);
      text-align: center;
      font-size: 12px;
      color: var(--ink-mute);
      border-top: 1px solid var(--line-soft);
    }
    .footer p { margin: 4px 0; }
    .footer .copyright { color: var(--ink-soft); font-weight: 500; }
    .footer .contact-cta {
      margin: 0 auto 14px;
      padding: 12px 16px;
      max-width: 460px;
      background: var(--bg);
      border: 1px solid var(--line-soft);
      border-radius: 10px;
      color: var(--ink-soft);
      font-size: 13px;
      line-height: 1.5;
    }
    .footer .powered { margin-top: 14px; font-size: 11px; color: var(--ink-mute); }
    @media (max-width: 480px) {
      .header { padding: 16px 18px 14px; }
      .content { padding: 22px 18px 4px; }
      .footer { padding: 18px 18px 22px; }
      .store-logo { max-height: 44px; max-width: 180px; }
    }
  </style>
</head>
<body>
  <div class="page">
    <div class="ribbon"></div>
    <div class="header">${header}</div>
    <div class="content" dir="auto">${content}</div>
    <div class="footer">
      ${contactBlock}
      <p class="copyright">© ${year} ${storeName}</p>
      ${footerLines.map(l => `<p>${l}</p>`).join('\n      ')}
      <p class="powered">Powered by Force AI</p>
    </div>
  </div>
</body>
</html>`;
}

export interface OrderEmailData {
  orderNumber: string;
  customerName: string;
  customerEmail: string;
  items: Array<{
    name: string;
    /** Live product's Arabic name; Arabic template prefers it over `name`. */
    nameAr?: string | null;
    quantity: number;
    price: number;
  }>;
  subtotal: number;
  tax: number;
  /** Order.taxIncludedInPrice — inclusive tax is already inside subtotal/total
   *  and prints as an "incl. VAT" caption after Total, never a summed row
   *  (orderTaxPlacement, issue 2210). */
  taxIncludedInPrice?: boolean | null;
  shipping: number;
  discount?: number;
  couponCode?: string;
  /** Name of the automatic promotion that discounted this order, when a
   *  promotion (rather than a coupon code) was the winning lever. Mutually
   *  exclusive with couponCode in practice — OrderService only ever persists
   *  one non-zero lever per order. */
  promotionName?: string;
  promotionNameAr?: string | null;
  total: number;
  shippingAddress: {
    firstName: string;
    lastName: string;
    address1: string;
    address2?: string;
    city: string;
    state: string;
    postalCode: string;
    country: string;
  };
}

export interface OrderRefundEmailData {
  orderNumber: string;
  customerName: string;
  customerEmail: string;
  /** Total of the original order in fils. */
  orderTotal: number;
  /** Refunded amount in fils — equals orderTotal for full refunds. */
  refundAmount: number;
  /** Optional admin-supplied reason shown to the customer. */
  reason?: string;
}

// Lazy platform-sender Resend client. Shared between sendPlatform +
// sendPlatformRaw so we don't instantiate the SDK on every admin email.
let _platformResend: import('resend').Resend | null = null;
async function getPlatformResend(): Promise<import('resend').Resend> {
  if (!_platformResend) {
    const { Resend } = await import('resend');
    _platformResend = new Resend(config.resendApiKey);
  }
  return _platformResend;
}

export class EmailService {
  // ---------------------------------------------------------------------------
  // Internal routing helpers
  // ---------------------------------------------------------------------------

  /**
   * Load store, wrap content in renderBrandedShell, ship via ResendService.
   * Used by all customer-facing send* methods.
   */
  private static async sendForStore(
    storeId: string,
    args: {
      to: string | string[];
      subject: string;
      content: string;
      text?: string;
      language?: 'en' | 'ar';
    },
    // `queue: true` routes the rendered email through the durable Redis retry
    // queue (email-queue.service) instead of calling Resend inline — used by the
    // order-lifecycle emails so a transient Resend failure retries (3×) instead
    // of vanishing. The queue drains back through EmailService.sendRaw, so no
    // recursion. Lazy import breaks the EmailService↔emailQueue cycle.
    opts?: { queue?: boolean }
  ): Promise<void> {
    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: {
        id: true,
        name: true,
        nameAr: true,
        logo: true,
        theme: true,
        email: true,
        phone: true,
        address: true,
        settings: true,
        domain: true,
        emailSenderLocalPart: true,
        emailDomainStatus: true,
      },
    });
    if (!store) throw new Error(`Store ${storeId} not found`);
    const storeDefaultLang =
      (store.settings as Record<string, unknown> | null)?.defaultLanguage === 'ar' ? 'ar' : 'en';
    const language = args.language ?? storeDefaultLang;
    const html = renderBrandedShell(args.content, {
      name: store.name,
      nameAr: store.nameAr,
      logo: store.logo,
      theme: store.theme as { primaryColor?: string | null; primary?: string | null } | null,
      email: store.email,
      phone: store.phone,
      address: store.address,
      defaultLanguage: language,
    });
    if (opts?.queue) {
      await emailQueue.enqueue(storeId, {
        to: args.to,
        subject: args.subject,
        html,
        text: args.text,
      });
      return;
    }
    await ResendService.sendBrandedEmail(storeId, {
      to: args.to,
      subject: args.subject,
      html,
      text: args.text,
    });
  }

  /**
   * Platform-level send (no store context). Used for admin alerts only.
   */
  private static async sendPlatform(
    args: {
      to: string | string[];
      subject: string;
      content: string;
      text?: string;
      replyTo?: string;
    },
    opts?: { queue?: boolean }
  ): Promise<void> {
    const html = renderBrandedShell(args.content, {
      name: 'Force AI Store',
      nameAr: null,
      logo: null,
      theme: null,
      email: null,
      phone: null,
      address: null,
      defaultLanguage: 'en',
    });
    if (opts?.queue) {
      // Durable retry queue (storeId=null → platform sender on drain).
      await emailQueue.enqueue(null, { to: args.to, subject: args.subject, html, text: args.text });
      return;
    }
    const r = await getPlatformResend();
    const payload: Record<string, unknown> = {
      from: 'Force AI Store <noreply@force-ai.co>',
      to: Array.isArray(args.to) ? args.to : [args.to],
      subject: args.subject,
      html,
    };
    if (args.text) payload.text = args.text;
    if (args.replyTo) payload.replyTo = args.replyTo;
    const { error } = await r.emails.send(
      payload as unknown as Parameters<typeof r.emails.send>[0]
    );
    if (error) throw new Error(`Resend send failed: ${error.message}`);
  }

  // ---------------------------------------------------------------------------
  // Queue-replay helpers (public, take pre-rendered html)
  // ---------------------------------------------------------------------------

  /**
   * Replay a queued email that already has a storeId — ships via
   * ResendService so the store's verified sender is used.
   */
  static async sendRaw(storeId: string, options: EmailOptions): Promise<void> {
    await ResendService.sendBrandedEmail(storeId, {
      to: options.to,
      subject: options.subject,
      html: options.html,
      text: options.text,
    });
  }

  /**
   * Replay a queued email with no store context — platform sender.
   */
  static async sendPlatformRaw(options: EmailOptions): Promise<void> {
    const r = await getPlatformResend();
    const payload: Record<string, unknown> = {
      from: 'Force AI Store <noreply@force-ai.co>',
      to: Array.isArray(options.to) ? options.to : [options.to],
      subject: options.subject,
      html: options.html,
    };
    if (options.text) payload.text = options.text;
    if (options.replyTo) payload.replyTo = options.replyTo;
    const { error } = await r.emails.send(
      payload as unknown as Parameters<typeof r.emails.send>[0]
    );
    if (error) throw new Error(`Resend send failed: ${error.message}`);
  }

  // ---------------------------------------------------------------------------
  // Customer-facing transactional emails (storeId required)
  // ---------------------------------------------------------------------------

  /**
   * Order Confirmation Email
   */
  static async sendOrderConfirmation(
    storeId: string,
    data: OrderEmailData,
    language?: 'en' | 'ar'
  ): Promise<void> {
    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: { name: true, settings: true },
    });
    if (!store) throw new Error(`Store ${storeId} not found`);
    const lang: 'en' | 'ar' =
      language ??
      ((store.settings as { defaultLanguage?: string } | null)?.defaultLanguage === 'ar'
        ? 'ar'
        : 'en');
    const subject = orderConfirmationTemplate.subject[lang](data, store.name);
    const content = orderConfirmationTemplate[lang](data, store.name);
    await this.sendForStore(
      storeId,
      { to: data.customerEmail, subject, content, language: lang },
      { queue: true }
    );
  }

  /**
   * Order Refund Email — sent when a refund is issued (gateway-initiated,
   * admin "Refund via MyFatoorah", or status-button refund). Always fires
   * from the order/refunded Inngest fanout AFTER the DB transaction
   * settled, so a Resend outage can't roll the refund back.
   */
  static async sendOrderRefunded(
    storeId: string,
    data: OrderRefundEmailData,
    language?: 'en' | 'ar'
  ): Promise<void> {
    if (!data.customerEmail) return;
    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: { name: true, settings: true },
    });
    if (!store) throw new Error(`Store ${storeId} not found`);
    const lang: 'en' | 'ar' =
      language ??
      ((store.settings as { defaultLanguage?: string } | null)?.defaultLanguage === 'ar'
        ? 'ar'
        : 'en');
    const subject = orderRefundedTemplate.subject[lang](data);
    const content = orderRefundedTemplate[lang](data);
    // Durable retry queue, like every other order-lifecycle email: this is
    // the ONE refund notice a customer gets (the order/refunded fanout claims
    // it once per order), so a transient Resend failure must retry rather
    // than vanish (#1935).
    await this.sendForStore(
      storeId,
      { to: data.customerEmail, subject, content, language: lang },
      { queue: true }
    );
  }

  /**
   * Payment Success Email
   */
  static async sendPaymentSuccess(
    storeId: string,
    data: OrderEmailData,
    language?: 'en' | 'ar'
  ): Promise<void> {
    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: { name: true, settings: true },
    });
    if (!store) throw new Error(`Store ${storeId} not found`);
    const lang: 'en' | 'ar' =
      language ??
      ((store.settings as { defaultLanguage?: string } | null)?.defaultLanguage === 'ar'
        ? 'ar'
        : 'en');
    const subject = paymentSuccessTemplate.subject[lang](data, store.name);
    const content = paymentSuccessTemplate[lang](data, store.name);
    await this.sendForStore(
      storeId,
      { to: data.customerEmail, subject, content, language: lang },
      { queue: true }
    );
  }

  /**
   * Payment Failed Email
   */
  static async sendPaymentFailed(
    storeId: string,
    data: {
      customerEmail: string;
      customerName: string;
      orderNumber: string;
      reason?: string;
    },
    language?: 'en' | 'ar'
  ): Promise<void> {
    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: { name: true, settings: true },
    });
    if (!store) throw new Error(`Store ${storeId} not found`);
    const lang: 'en' | 'ar' =
      language ??
      ((store.settings as { defaultLanguage?: string } | null)?.defaultLanguage === 'ar'
        ? 'ar'
        : 'en');
    const subject = paymentFailedTemplate.subject[lang](data, store.name);
    const content = paymentFailedTemplate[lang](data, store.name, config.webUrl);
    await this.sendForStore(storeId, { to: data.customerEmail, subject, content, language: lang });
  }

  /**
   * Order Shipped Email
   */
  static async sendOrderShipped(
    storeId: string,
    data: {
      customerEmail: string;
      customerName: string;
      orderNumber: string;
      trackingNumber?: string;
      trackingUrl?: string;
      carrier?: string;
    },
    language?: 'en' | 'ar'
  ): Promise<void> {
    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: { name: true, settings: true },
    });
    if (!store) throw new Error(`Store ${storeId} not found`);
    const lang: 'en' | 'ar' =
      language ??
      ((store.settings as { defaultLanguage?: string } | null)?.defaultLanguage === 'ar'
        ? 'ar'
        : 'en');
    const subject = orderShippedTemplate.subject[lang](data, store.name);
    const content = orderShippedTemplate[lang](data, store.name);
    await this.sendForStore(
      storeId,
      { to: data.customerEmail, subject, content, language: lang },
      { queue: true }
    );
  }

  /**
   * Password Reset Email
   */
  static async sendPasswordReset(
    storeId: string,
    data: {
      email: string;
      name: string;
      resetUrl: string;
      expiresInMinutes: number;
    },
    language?: 'en' | 'ar'
  ): Promise<void> {
    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: { name: true, settings: true },
    });
    if (!store) throw new Error(`Store ${storeId} not found`);
    const lang: 'en' | 'ar' =
      language ??
      ((store.settings as { defaultLanguage?: string } | null)?.defaultLanguage === 'ar'
        ? 'ar'
        : 'en');
    const subject = passwordResetTemplate.subject[lang](data, store.name);
    const content = passwordResetTemplate[lang](data, store.name);
    await this.sendForStore(storeId, { to: data.email, subject, content, language: lang });
  }

  /**
   * Welcome Email
   */
  static async sendWelcome(
    storeId: string,
    data: { email: string; name: string },
    language?: 'en' | 'ar'
  ): Promise<void> {
    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: { name: true, settings: true },
    });
    if (!store) throw new Error(`Store ${storeId} not found`);
    const lang: 'en' | 'ar' =
      language ??
      ((store.settings as { defaultLanguage?: string } | null)?.defaultLanguage === 'ar'
        ? 'ar'
        : 'en');
    const subject = welcomeTemplate.subject[lang](data, store.name);
    const content = welcomeTemplate[lang](data, store.name, config.webUrl);
    await this.sendForStore(storeId, { to: data.email, subject, content, language: lang });
  }

  /**
   * Email Verification
   */
  static async sendEmailVerification(
    storeId: string,
    data: {
      email: string;
      name: string;
      verificationUrl: string;
      expiresInHours: number;
    },
    language?: 'en' | 'ar'
  ): Promise<void> {
    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: { name: true, settings: true },
    });
    if (!store) throw new Error(`Store ${storeId} not found`);
    const lang: 'en' | 'ar' =
      language ??
      ((store.settings as { defaultLanguage?: string } | null)?.defaultLanguage === 'ar'
        ? 'ar'
        : 'en');
    const subject = emailVerificationTemplate.subject[lang](data, store.name);
    const content = emailVerificationTemplate[lang](data, store.name);
    await this.sendForStore(storeId, { to: data.email, subject, content, language: lang });
  }

  /**
   * Duplicate-registration notice. Sent to the rightful owner when
   * someone (or themselves) submits the register form with their
   * existing email.
   */
  static async sendDuplicateRegistrationNotice(
    storeId: string,
    data: {
      email: string;
      name: string;
      storeName?: string;
    },
    language?: 'en' | 'ar'
  ): Promise<void> {
    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: { name: true, settings: true },
    });
    if (!store) throw new Error(`Store ${storeId} not found`);
    const lang: 'en' | 'ar' =
      language ??
      ((store.settings as { defaultLanguage?: string } | null)?.defaultLanguage === 'ar'
        ? 'ar'
        : 'en');
    const subject = duplicateRegistrationTemplate.subject[lang](data, store.name);
    const content = duplicateRegistrationTemplate[lang](data, store.name, config.webUrl);
    await this.sendForStore(storeId, { to: data.email, subject, content, language: lang });
  }

  /**
   * Resend Email Verification
   */
  static async sendResendVerification(
    storeId: string,
    data: {
      email: string;
      name: string;
      verificationUrl: string;
      expiresInHours: number;
    },
    language?: 'en' | 'ar'
  ): Promise<void> {
    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: { name: true, settings: true },
    });
    if (!store) throw new Error(`Store ${storeId} not found`);
    const lang: 'en' | 'ar' =
      language ??
      ((store.settings as { defaultLanguage?: string } | null)?.defaultLanguage === 'ar'
        ? 'ar'
        : 'en');
    const subject = resendVerificationTemplate.subject[lang](data, store.name);
    const content = resendVerificationTemplate[lang](data, store.name);
    await this.sendForStore(storeId, { to: data.email, subject, content, language: lang });
  }

  /**
   * Send Return Confirmation Email
   */
  static async sendReturnConfirmation(
    storeId: string,
    data: {
      email: string;
      customerName: string;
      storeName: string;
      returnNumber: string;
      orderNumber: string;
      type: string;
    },
    language?: 'en' | 'ar'
  ) {
    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: { name: true, settings: true },
    });
    if (!store) throw new Error(`Store ${storeId} not found`);
    const lang: 'en' | 'ar' =
      language ??
      ((store.settings as { defaultLanguage?: string } | null)?.defaultLanguage === 'ar'
        ? 'ar'
        : 'en');
    const subject = returnConfirmationTemplate.subject[lang](data, store.name);
    const content = returnConfirmationTemplate[lang](data, store.name);
    // `queue: true` — same durable Redis retry path the order-lifecycle
    // emails use. The render (two Prisma reads) stays synchronous so it runs
    // inside the caller's tenant transaction; only the Resend call moves to
    // the queue drainer, where a transient failure retries 3x instead of
    // vanishing. Before this, the whole chain was fired-and-forgotten past
    // the response and died on a committed transaction (P2028) at
    // `resend.service.ts` — every return confirmation silently unsent.
    await this.sendForStore(
      storeId,
      { to: data.email, subject, content, language: lang },
      { queue: true }
    );
  }

  /**
   * Send Return Status Update Email
   */
  static async sendReturnStatusUpdate(
    storeId: string,
    data: {
      email: string;
      customerName: string;
      storeName: string;
      returnNumber: string;
      status: string;
      notes?: string;
    },
    language?: 'en' | 'ar'
  ) {
    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: { name: true, settings: true },
    });
    if (!store) throw new Error(`Store ${storeId} not found`);
    const lang: 'en' | 'ar' =
      language ??
      ((store.settings as { defaultLanguage?: string } | null)?.defaultLanguage === 'ar'
        ? 'ar'
        : 'en');
    const subject = returnStatusUpdateTemplate.subject[lang](data, store.name);
    const content = returnStatusUpdateTemplate[lang](data, store.name);
    // Durable queue, same reasoning as sendReturnConfirmation above.
    await this.sendForStore(
      storeId,
      { to: data.email, subject, content, language: lang },
      { queue: true }
    );
  }

  /**
   * Post-purchase review request — fires 7 days after delivery via Inngest.
   *
   * Receives all items for the order so a consolidated email can be sent
   * (one email, one CTA per product). The caller (review-request Inngest
   * function) already resolved the correct locale; `language` is required.
   */
  static async sendReviewRequest(
    storeId: string,
    data: ReviewRequestData,
    language: 'en' | 'ar'
  ): Promise<void> {
    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: { name: true, settings: true },
    });
    if (!store) throw new Error(`Store ${storeId} not found`);
    const subject = reviewRequestTemplate.subject[language](data, store.name);
    const content = reviewRequestTemplate[language](data, store.name);
    await this.sendForStore(storeId, { to: data.to, subject, content, language });
  }

  /**
   * Send invoice email to customer.
   */
  static async sendInvoice(
    storeId: string,
    data: { to: string | string[]; orderNumber: string; html: string },
    language?: 'en' | 'ar'
  ): Promise<void> {
    await this.sendForStore(storeId, {
      to: data.to,
      subject: `Invoice ${data.orderNumber}`,
      content: data.html,
      language,
    });
  }

  // ---------------------------------------------------------------------------
  // Merchant-facing operational alerts (sent to the store owner, not the customer)
  // ---------------------------------------------------------------------------

  /**
   * Low Stock Digest Alert — sent to the store owner when one or more products
   * drop below their configured threshold.
   *
   * Uses the store's branded shell and the store's default language so the
   * owner receives the alert in their preferred locale.
   *
   * Recipient: `to` is provided by the caller (runLowStockScan resolves
   * store.owner.email via a withRlsBypass query; this method accepts it
   * as a parameter so the scan service doesn't need to re-fetch the store).
   */
  static async sendLowStockAlert(
    storeId: string,
    data: {
      to: string;
      items: LowStockAlertItem[];
      storeName: string;
      adminUrl: string;
    },
    language?: 'en' | 'ar'
  ): Promise<void> {
    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: { name: true, settings: true },
    });
    const lang: 'en' | 'ar' =
      language ??
      ((store?.settings as { defaultLanguage?: string } | null)?.defaultLanguage === 'ar'
        ? 'ar'
        : 'en');
    const alertData = {
      items: data.items,
      storeName: data.storeName,
      adminUrl: data.adminUrl,
    };
    const subject = lowStockAlertTemplate.subject[lang](alertData);
    const content = lowStockAlertTemplate[lang](alertData);
    await this.sendForStore(storeId, { to: data.to, subject, content, language: lang });
  }

  // ---------------------------------------------------------------------------
  // Admin / platform-facing emails (no storeId — platform sender)
  // ---------------------------------------------------------------------------

  /**
   * Admin Alert: New Order
   */
  static async sendAdminNewOrder(data: OrderEmailData): Promise<void> {
    const content = this.adminNewOrderTemplate(data);
    await this.sendPlatform(
      {
        to: config.smtpFromEmail,
        subject: `New Order Received - #${data.orderNumber}`,
        content,
      },
      { queue: true }
    );
  }

  /**
   * Admin Alert: Refund Processed
   */
  static async sendAdminRefund(data: {
    orderNumber: string;
    amount: number;
    reason?: string;
  }): Promise<void> {
    const content = this.adminRefundTemplate(data);
    await this.sendPlatform(
      {
        to: config.smtpFromEmail,
        subject: `Refund Processed - Order #${data.orderNumber}`,
        content,
      },
      { queue: true }
    );
  }

  /**
   * Send Contact Form Email to Admin
   */
  static async sendContactForm(data: {
    name: string;
    email: string;
    subject: string;
    message: string;
  }): Promise<void> {
    const content = this.contactFormTemplate(data);
    await this.sendPlatform({
      to: config.smtpFromEmail,
      subject: `Contact Form: ${data.subject}`,
      content,
      text: this.htmlToText(
        renderBrandedShell(content, {
          name: 'Force AI Store',
          nameAr: null,
          logo: null,
          theme: null,
          email: null,
          phone: null,
          address: null,
          defaultLanguage: 'en',
        })
      ),
      replyTo: data.email,
    });
  }

  // ---------------------------------------------------------------------------
  // Admin / internal template helpers — platform-only, not bilingual
  // ---------------------------------------------------------------------------

  /**
   * Admin New Order Template
   */
  private static adminNewOrderTemplate(d: OrderEmailData): string {
    return `
      <h2>New Order Received</h2>
      <p><strong>Order #${escapeHtml(d.orderNumber)}</strong></p>
      <p><strong>Customer:</strong> ${escapeHtml(d.customerName)} (${escapeHtml(
        d.customerEmail
      )})</p>
      <p><strong>Total:</strong> ${(d.total / 1000).toFixed(3)} KWD</p>
      <p><strong>Items:</strong> ${d.items.length}</p>
      <p style="text-align: center; margin: 24px 0;">
        <a href="${config.adminUrl}/orders" class="button">View Order</a>
      </p>
    `;
  }

  /**
   * Admin Refund Template
   */
  private static adminRefundTemplate(d: {
    orderNumber: string;
    amount: number;
    reason?: string;
  }): string {
    return `
      <h2>Refund Processed</h2>
      <p><strong>Order #${escapeHtml(d.orderNumber)}</strong></p>
      <p><strong>Amount:</strong> ${(d.amount / 1000).toFixed(3)} KWD</p>
      ${d.reason ? `<p><strong>Reason:</strong> ${escapeHtml(d.reason)}</p>` : ''}
      <p style="text-align: center; margin: 24px 0;">
        <a href="${config.adminUrl}/orders" class="button">View Details</a>
      </p>
    `;
  }

  /**
   * Contact Form Template
   */
  private static contactFormTemplate(d: {
    name: string;
    email: string;
    subject: string;
    message: string;
  }): string {
    return `
      <h2>New Contact Form Submission</h2>
      <p><strong>From:</strong> ${escapeHtml(d.name)} (${escapeHtml(d.email)})</p>
      <p><strong>Subject:</strong> ${escapeHtml(d.subject)}</p>
      <div style="background: #f9f9f9; padding: 16px; border-radius: 4px; margin: 16px 0; white-space: pre-wrap;">${escapeHtml(
        d.message
      )}</div>
      <p style="font-size: 14px; color: #666;">You can reply directly to this email to respond to the sender.</p>
    `;
  }

  /**
   * Convert HTML to plain text
   */
  private static htmlToText(html: string): string {
    return html
      .replace(/<style[^>]*>.*?<\/style>/gs, '')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
}
