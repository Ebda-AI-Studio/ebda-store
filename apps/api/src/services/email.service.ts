import {
  wholesaleNotice,
  wholesaleMerchantNotice,
  type WholesaleNoticeKind,
} from './email-templates/wholesale';
import { withStore } from '@ebda/database';
import { config } from '../config';
import logger from '../lib/logger';
import { isDemoStore } from '../lib/demo-store';
import { storeBrandTheme } from '../lib/store-brand-theme';
import { StoreMailer } from './store-mailer.service';
import { sendMail } from './mail-transport';
// Static import is safe despite the email-queue↔email-service cycle: both sides
// use the other only at call-time (sendForStore / the queue's drain), never at
// module load, so ES live-bindings resolve it. `queue: true` routes order emails
// through the durable Redis retry queue (E2-5).
import { emailQueue } from './email-queue.service';
import { welcomeTemplate } from './email-templates/welcome';
import {
  GOLD_RATE_NOTICES,
  type GoldRateNoticeData,
  type GoldRateNoticeKind,
} from './email-templates/gold-rate-notices';
import { passwordResetTemplate } from './email-templates/password-reset';
import { passkeyNoticeTemplate, type PasskeyNoticeData } from './email-templates/passkey-notice';
import { emailVerificationTemplate } from './email-templates/email-verification';
import { resendVerificationTemplate } from './email-templates/resend-verification';
import { duplicateRegistrationTemplate } from './email-templates/duplicate-registration';
import { orderConfirmationTemplate } from './email-templates/order-confirmation';
import type { EmailBarcode } from './email-templates/_barcode';
import { ensureEmailBarcode } from './barcode-image.service';
import { buildOrderEmailWaMe } from './email-templates/_wa-me';
import { emailMoney } from './email-templates/_util';
import {
  EMAIL_COLORS,
  EMAIL_FONT,
  EMAIL_FONT_AR,
  EMAIL_LOGO_WIDTH,
  EMAIL_LOGO_MAX_HEIGHT,
  EMAIL_MAX_WIDTH,
  emailColor,
  emailImage,
  emailSides,
  emailTint,
  inlineEmailStyles,
  type EmailDir,
} from './email-templates/_layout';
import {
  contactEnquiryHtml,
  contactEnquiryReceipt,
  contactEnquiryText,
  type ContactEnquiryData,
} from './email-templates/contact-enquiry';
import { orderRefundedTemplate } from './email-templates/order-refunded';
import {
  orderCancelledNotChargedTemplate,
  type OrderCancelledEmailData,
} from './email-templates/order-cancelled-not-charged';
import { paymentSuccessTemplate } from './email-templates/payment-success';
import { paymentFailedTemplate } from './email-templates/payment-failed';
import { orderShippedTemplate } from './email-templates/order-shipped';
import { returnConfirmationTemplate } from './email-templates/return-confirmation';
import { returnStatusUpdateTemplate } from './email-templates/return-status-update';
import { reviewRequestTemplate, type ReviewRequestData } from './email-templates/review-request';
import { lowStockAlertTemplate, type LowStockAlertItem } from './email-templates/low-stock-alert';
import {
  planLimitReachedTemplate,
  type PlanLimitReachedData,
} from './email-templates/plan-limit-reached';
import { oneClickUnsubscribeHeaders } from '../lib/lifecycle-unsubscribe-token';
import { lifecycleTemplate, type LifecycleEmailData } from './email-templates/lifecycle';
import {
  subscriptionBillingTemplate,
  type SubscriptionBillingNoticeData,
} from './email-templates/subscription-billing';
import {
  webhookDisabledTemplate,
  type WebhookDisabledData,
} from './email-templates/webhook-disabled';
import { BRAND, BRAND_EMAIL_LOGO_URL, brandFrom, poweredByBrand } from '@ebda/shared';

import { resolveDefaultLanguage } from '@ebda/shared';
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
  /** Extra message headers (RFC 8058 List-Unsubscribe / List-Unsubscribe-Post). Marketing and lifecycle mail only. */
  headers?: Record<string, string>;
  /** Platform sends only: the From display name. Default = the product (`Ebda Store`); account mail passes `Ebda AI Studio`. */
  fromName?: string;
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
  /** Omit the "Powered by Ebda" footer line (plan `brandingRemoval` -> `remove_branding`). */
  hidePoweredBy?: boolean;
}

/**
 * Whether a store's customer-facing mail drops the "Powered by Ebda" line.
 * Same decision as the storefront footer: the `remove_branding` feature the
 * plan layer resolves (Growth + Business, or a super-admin override). Fails
 * toward SHOWING the line. Lazy import: feature.service -> store.service ->
 * plan-limit.service -> email.service would otherwise be a cycle.
 */
export async function storeHidesPoweredBy(storeId: string): Promise<boolean> {
  try {
    const { featureService } = await import('./feature.service.js');
    return await featureService.isFeatureEnabled(storeId, 'remove_branding');
  } catch (err) {
    logger.warn({ err, storeId }, '[email] branding lookup failed — keeping the Powered-by line');
    return false;
  }
}

/**
 * The branded wrapper every customer/merchant email ships in.
 *
 * Email-client-safe by construction (Demo Store invoice on the Gmail Android
 * app, 2026-09-30): NO `<style>` block — Gmail and Outlook drop or partially
 * drop them, and the old shell's `var()`/`color-mix()` rules were discarded
 * wholesale, so every class-sized element rendered at its natural size. The
 * layout is a 600px presentation table (`width="600"` for Outlook, fluid
 * `width:100%;max-width:600px` elsewhere), every colour is solid hex, the
 * logo is an `emailImage` scaled whole into a 160×64 box, and the content is run through
 * `inlineEmailStyles` so templates' `.button`/`.order-table`/headings carry
 * inline styles. `dir` is set on the html, the wrapper table and the content
 * cell, with physical alignment, so Arabic reads right-to-left everywhere.
 */
export function renderBrandedShell(content: string, store: EmailStoreContext): string {
  const isArabic = store.defaultLanguage === 'ar';
  const dir: EmailDir = isArabic ? 'rtl' : 'ltr';
  const { start } = emailSides(dir);
  const c = EMAIL_COLORS;
  // Prefer canonical `primaryColor` token; fall back to legacy `primary` for
  // any old admin payloads that pre-date the rename.
  const rawBrand = store.theme?.primaryColor ?? store.theme?.primary ?? null;
  const brand = emailColor(rawBrand);
  const brandSoft = emailTint(brand, 0.06);
  const font = isArabic ? EMAIL_FONT_AR : EMAIL_FONT;
  const displayName = isArabic && store.nameAr ? store.nameAr : store.name;
  const storeName = escapeHtml(displayName);
  const platformMark = store.logo === BRAND_EMAIL_LOGO_URL;
  // Merchant logos retain their own identity. The platform mark is abbreviated,
  // so it also displays the full localized product name.
  const header = store.logo
    ? emailImage({
        src: store.logo,
        alt: displayName,
        // The platform mark is portrait (135x256 PNG): width 34 = 64 * 135/256, so Outlook (which reads only the
        // width attribute) renders it at the same 34x64 every other client scales it to.
        width: platformMark ? 34 : EMAIL_LOGO_WIDTH,
        maxHeight: EMAIL_LOGO_MAX_HEIGHT,
        align: 'center',
      })
    : `<div class="store-name" style="font-size:22px;line-height:28px;font-weight:700;color:${c.ink};">${storeName}</div>`;
  const brandedHeader = platformMark
    ? `${header}<div class="store-name" style="font-size:22px;line-height:28px;font-weight:700;color:${c.ink};">${storeName}</div>`
    : header;
  const year = new Date().getFullYear();
  const footerLines: string[] = [];
  if (store.address) footerLines.push(escapeHtml(store.address));
  if (store.phone) {
    const safePhone = escapeHtml(store.phone);
    // Strip non-digit chars from tel: target so it dials correctly on mobile
    // while keeping the formatted version visible to readers.
    const dial = store.phone.replace(/[^+\d]/g, '');
    footerLines.push(
      `<a dir="ltr" href="tel:${escapeHtml(dial)}" style="color:${c.inkSoft};text-decoration:none;">${safePhone}</a>`
    );
  }
  // Contact line — replaces the per-template "please reply to this email"
  // sentence so every branded email has a canonical reachable contact.
  const contactBlock = store.email
    ? `<p class="contact-cta" style="margin:0 auto 14px;padding:12px 16px;max-width:460px;background-color:${c.bg};border:1px solid ${c.lineSoft};border-radius:10px;color:${c.inkSoft};font-size:13px;line-height:1.5;">${
        isArabic ? 'عندك سؤال؟ ابعتلنا على' : 'Questions? Email us at'
      } <a href="mailto:${escapeHtml(store.email)}" style="color:${brand};text-decoration:none;font-weight:600;">${escapeHtml(
        store.email
      )}</a></p>`
    : '';
  const footerP = `margin:4px 0;font-size:12px;color:${c.inkMute};`;

  return `<!DOCTYPE html>
<html dir="${dir}" lang="${isArabic ? 'ar' : 'en'}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="x-apple-disable-message-reformatting">
  <meta name="color-scheme" content="light only">
  <meta name="supported-color-schemes" content="light only">
  <title>${storeName}</title>
</head>
<body dir="${dir}" bgcolor="${c.bgSoft}" style="margin:0;padding:0;width:100%;background-color:${c.bgSoft};color:${c.ink};font-family:${font};font-size:14px;line-height:1.5;-webkit-text-size-adjust:100%;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${c.bgSoft}" style="width:100%;background-color:${c.bgSoft};">
    <tr>
      <td align="center" style="padding:24px 12px;">
        <table role="presentation" class="page" dir="${dir}" width="${EMAIL_MAX_WIDTH}" cellpadding="0" cellspacing="0" border="0" bgcolor="${c.bg}" style="width:100%;max-width:${EMAIL_MAX_WIDTH}px;background-color:${c.bg};border:1px solid ${c.line};border-radius:16px;border-collapse:separate;">
          <tr>
            <td height="6" bgcolor="${brand}" style="height:6px;line-height:6px;font-size:0;background-color:${brand};border-radius:16px 16px 0 0;">&nbsp;</td>
          </tr>
          <tr>
            <td class="header" align="center" bgcolor="${brandSoft}" style="padding:20px 24px 18px;text-align:center;background-color:${brandSoft};border-bottom:1px solid ${c.lineSoft};">${brandedHeader}</td>
          </tr>
          <tr>
            <td class="content" dir="${dir}" align="${start}" style="padding:24px 24px 8px;text-align:${start};color:${c.ink};font-family:${font};font-size:14px;line-height:1.5;">${inlineEmailStyles(
              content,
              { dir, brand }
            )}</td>
          </tr>
          <tr>
            <td class="footer" align="center" bgcolor="${c.bgSoft}" style="padding:22px 24px 26px;text-align:center;background-color:${c.bgSoft};border-top:1px solid ${c.lineSoft};border-radius:0 0 16px 16px;font-size:12px;color:${c.inkMute};">
              ${contactBlock}
              <p class="copyright" style="${footerP}color:${c.inkSoft};font-weight:500;">© ${year} ${storeName}</p>
              ${footerLines.map(l => `<p style="${footerP}">${l}</p>`).join('\n              ')}
              ${store.hidePoweredBy ? '' : `<p class="powered" style="margin:14px 0 0;font-size:11px;color:${c.inkMute};">${poweredByBrand(isArabic ? 'ar' : 'en')}</p>`}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export interface OrderEmailData {
  orderNumber: string;
  /** The order barcode PNG (merchant's shape or plain); absent/null = the number stays text-only. */
  barcode?: EmailBarcode | null;
  customerName: string;
  customerEmail: string;
  items: Array<{
    name: string;
    /** Live product's Arabic name; Arabic template prefers it over `name`. */
    nameAr?: string | null;
    /** Snapshotted variant title ("Large / Red"). */
    variantName?: string | null;
    /** Arabic variant snapshot (Ruling B0-41); the Arabic template prefers it. */
    variantNameAr?: string | null;
    /** The customer's personalisation text, rendered as "✎ text" under the name. */
    personalisation?: string | null;
    quantity: number;
    price: number;
  }>;
  subtotal: number;
  tax: number;
  /** Order.taxIncludedInPrice — inclusive tax is already inside subtotal/total
   *  and prints as an "incl. VAT" caption after Total, never a summed row
   *  (orderTaxPlacement, issue 2210). */
  taxIncludedInPrice?: boolean | null;
  /** Frozen on the order ONLY when VAT was collected under a verified profile
   *  (ruling TAX-2): makes the email show the seller TRN and "VAT (14%)". */
  sellerTaxRegistrationNumber?: string | null;
  sellerTaxLegalName?: string | null;
  taxRateBps?: number | null;
  /** Frozen VAT base (ruling MONEYB-2); null/absent on legacy orders. */
  taxableAmount?: number | null;
  shipping: number;
  /** COD fee frozen at creation, inside `total` (ruling MONEYB-3). */
  codFee?: number;
  discount?: number;
  /** The levers `discount` is made of (issue 2239) — see order.service create(). */
  couponDiscount?: number;
  promotionDiscount?: number;
  loyaltyDiscount?: number;
  loyaltyPointsRedeemed?: number | null;
  /** The order's currency; money renders in it (issue 1705). Default EGP. */
  currency?: string;
  couponCode?: string;
  /** Name of the automatic promotion that discounted this order, when a
   *  promotion (rather than a coupon code) was the winning lever. Mutually
   *  exclusive with couponCode in practice — OrderService only ever persists
   *  one non-zero lever per order. */
  promotionName?: string;
  promotionNameAr?: string | null;
  total: number;
  /** The delivery pick (the first notes line without its prefix); absent when the order has none. */
  deliveryLine?: string | null;
  shippingAddress: {
    firstName: string;
    lastName: string;
    address1: string;
    address2?: string;
    city: string;
    state: string;
    postalCode: string;
    country: string;
    /** Egyptian checkout fields (city/state/postalCode are empty there). */
    area?: string;
    areaAr?: string;
    governorate?: string;
    governorateAr?: string;
  };
  /** Cash-on-delivery order — drives the "Confirm on WhatsApp" prompt. */
  isCod?: boolean;
  /** Free-tier `wa.me` link (set by `sendOrderConfirmation`; absent without a store number). */
  waMe?: { url: string; kind: 'cod_confirm' | 'order_question' };
}

export interface OrderRefundEmailData {
  orderNumber: string;
  customerName: string;
  customerEmail: string;
  /** Total of the original order in piastres. */
  orderTotal: number;
  /** Refunded amount in piastres — equals orderTotal for full refunds. */
  refundAmount: number;
  /** Optional admin-supplied reason shown to the customer. */
  reason?: string;
  /** The order's currency; money renders in it (issue 1705). Default EGP. */
  currency?: string;
}

/** A header value on one line: a shopper-typed subject must not carry CR/LF into the email. */
function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

export class EmailService {
  // ---------------------------------------------------------------------------
  // Internal routing helpers
  // ---------------------------------------------------------------------------

  /**
   * Load store, wrap content in renderBrandedShell, ship via StoreMailer.
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
      replyTo?: string;
    },
    // `queue: true` routes the rendered email through the durable Redis retry
    // queue (email-queue.service) instead of calling Resend inline — used by the
    // order-lifecycle emails so a transient Resend failure retries (3×) instead
    // of vanishing. The queue drains back through EmailService.sendRaw, so no
    // recursion. Lazy import breaks the EmailService↔emailQueue cycle.
    opts?: { queue?: boolean }
  ): Promise<void> {
    const store = await withStore(storeId, tx =>
      tx.store.findUnique({
        where: { id: storeId },
        select: {
          id: true,
          name: true,
          nameAr: true,
          logo: true,
          theme: true,
          look: true,
          template: true,
          email: true,
          phone: true,
          address: true,
          settings: true,
          domain: true,
          emailSenderLocalPart: true,
          emailDomainStatus: true,
        },
      })
    );
    if (!store) throw new Error(`Store ${storeId} not found`);
    const storeDefaultLang = resolveDefaultLanguage(
      (store.settings as Record<string, unknown> | null)?.defaultLanguage
    );
    const language = args.language ?? storeDefaultLang;
    const html = renderBrandedShell(args.content, {
      name: store.name,
      nameAr: store.nameAr,
      logo: store.logo,
      // A look store's brand colour is the look's unless the merchant stored one (LOOKS-14).
      theme: storeBrandTheme(store) as EmailStoreContext['theme'],
      email: store.email,
      phone: store.phone,
      address: store.address,
      defaultLanguage: language,
      hidePoweredBy: await storeHidesPoweredBy(storeId),
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
    await StoreMailer.sendBrandedEmail(storeId, {
      to: args.to,
      subject: args.subject,
      html,
      text: args.text,
      replyTo: args.replyTo,
    });
  }

  /**
   * THE choke point for every merchant-facing store mail (owner/staff notices: gold rate, low stock, plan limit, webhook,
   * billing, wholesale). A demo store (`is_demo`, the looks showroom) has no merchant: nothing is sent and the skip is logged
   * at info. Customer-facing mail keeps `sendForStore` (a demo refuses every order and customer signup, so none exists).
   * Add every new merchant notice here, never straight to `sendForStore`.
   */
  private static async sendMerchantNotice(
    storeId: string,
    args: Parameters<typeof EmailService.sendForStore>[1],
    opts?: { queue?: boolean }
  ): Promise<void> {
    if (await isDemoStore(storeId)) {
      logger.info({ storeId, subject: args.subject }, 'merchant notice skipped: demo store');
      return;
    }
    await this.sendForStore(storeId, args, opts);
  }

  /**
   * Platform-level send (Ebda sender, no store branding): a store's refund alert to its own
   * order address (FU46-1a). (The old contact-form fallback to Ebda's inbox is gone — FU46-1c.)
   */
  private static async sendPlatform(
    args: {
      to: string | string[];
      subject: string;
      content: string;
      text?: string;
      replyTo?: string;
      /** Shell direction + brand name; default = the platform default language. */
      language?: 'en' | 'ar';
      headers?: Record<string, string>;
    },
    opts?: { queue?: boolean }
  ): Promise<void> {
    const html = renderBrandedShell(args.content, {
      name: BRAND.product.nameEn,
      nameAr: BRAND.product.nameAr,
      logo: BRAND_EMAIL_LOGO_URL,
      theme: null,
      email: null,
      phone: null,
      address: null,
      defaultLanguage: args.language ?? resolveDefaultLanguage(undefined),
    });
    if (opts?.queue) {
      // Durable retry queue (storeId=null → platform sender on drain).
      await emailQueue.enqueue(null, {
        to: args.to,
        subject: args.subject,
        html,
        text: args.text,
        ...(args.headers ? { headers: args.headers } : {}),
      });
      return;
    }
    await sendMail({
      from: brandFrom(),
      to: args.to,
      subject: args.subject,
      html,
      ...(args.text ? { text: args.text } : {}),
      ...(args.replyTo ? { replyTo: args.replyTo } : {}),
      ...(args.headers ? { headers: args.headers } : {}),
    });
  }

  // ---------------------------------------------------------------------------
  // Queue-replay helpers (public, take pre-rendered html)
  // ---------------------------------------------------------------------------

  /**
   * Replay a queued email that already has a storeId — ships via
   * StoreMailer so the store's verified sender is used.
   */
  static async sendRaw(storeId: string, options: EmailOptions): Promise<{ id: string }> {
    return StoreMailer.sendBrandedEmail(storeId, {
      to: options.to,
      subject: options.subject,
      html: options.html,
      text: options.text,
    });
  }

  /**
   * Replay a queued email with no store context — platform sender.
   */
  static async sendPlatformRaw(options: EmailOptions): Promise<{ id: string }> {
    return sendMail({
      from: brandFrom(options.fromName),
      to: options.to,
      subject: options.subject,
      html: options.html,
      ...(options.text ? { text: options.text } : {}),
      ...(options.replyTo ? { replyTo: options.replyTo } : {}),
      ...(options.headers ? { headers: options.headers } : {}),
    });
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
    const store = await withStore(storeId, tx =>
      tx.store.findUnique({
        where: { id: storeId },
        select: { name: true, nameAr: true, settings: true, whatsapp: true, theme: true },
      })
    );
    if (!store) throw new Error(`Store ${storeId} not found`);
    const lang: 'en' | 'ar' =
      language ??
      resolveDefaultLanguage(
        (store.settings as { defaultLanguage?: string } | null)?.defaultLanguage
      );
    // Free-tier wa.me link (no API): only when the store has a valid number.
    // The barcode PNG (the merchant's shape; plain by default; `off` = none). The fanout that
    // calls this runs after commit on Inngest; a missing/failed image NEVER blocks the email.
    const shape =
      (store.settings as { receiptBarcodeShape?: string } | null)?.receiptBarcodeShape ?? 'plain';
    let barcode = data.barcode;
    if (barcode === undefined && shape !== 'off') {
      barcode = await ensureEmailBarcode({
        storeId,
        kind: 'order',
        number: data.orderNumber,
        shape,
      }).catch(() => null);
    }
    const withWaMe: OrderEmailData = {
      ...data,
      barcode,
      waMe: buildOrderEmailWaMe(data, store, lang),
    };
    const subject = orderConfirmationTemplate.subject[lang](withWaMe, store.name);
    const content = orderConfirmationTemplate[lang](withWaMe, store.name);
    await this.sendForStore(
      storeId,
      { to: data.customerEmail, subject, content, language: lang },
      { queue: true }
    );
  }

  /**
   * Order Refund Email — sent when a refund is issued (gateway-initiated,
   * admin "Refund via provider", or status-button refund). Always fires
   * from the order/refunded Inngest fanout AFTER the DB transaction
   * settled, so a Resend outage can't roll the refund back.
   */
  static async sendOrderRefunded(
    storeId: string,
    data: OrderRefundEmailData,
    language?: 'en' | 'ar'
  ): Promise<void> {
    if (!data.customerEmail) return;
    const store = await withStore(storeId, tx =>
      tx.store.findUnique({
        where: { id: storeId },
        select: { name: true, settings: true },
      })
    );
    if (!store) throw new Error(`Store ${storeId} not found`);
    const lang: 'en' | 'ar' =
      language ??
      resolveDefaultLanguage(
        (store.settings as { defaultLanguage?: string } | null)?.defaultLanguage
      );
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
   * B2B wholesale application notices to the APPLICANT's account email only (received / approved / rejected). Queued with
   * the order-lifecycle emails so a transient provider failure retries instead of vanishing.
   */
  /** Merchant-facing wholesale notice (new application / 48h nudge) to the store owner. Throws on failure; callers log it. */
  static async sendWholesaleMerchantNotice(
    storeId: string,
    args: {
      kind: 'received' | 'nudge';
      businessName?: string;
      pendingCount: number;
      adminUrl: string;
      to?: string | null;
    }
  ): Promise<void> {
    const store = await withStore(storeId, tx =>
      tx.store.findUnique({
        where: { id: storeId },
        select: { name: true, settings: true, owner: { select: { email: true } } },
      })
    );
    if (!store) throw new Error(`Store ${storeId} not found`);
    const to = args.to ?? store.owner?.email;
    if (!to) return;
    const lang: 'en' | 'ar' = resolveDefaultLanguage(
      (store.settings as { defaultLanguage?: string } | null)?.defaultLanguage
    );
    const { subject, content } = wholesaleMerchantNotice(args.kind, lang, {
      storeName: store.name,
      businessName: args.businessName,
      pendingCount: args.pendingCount,
      adminUrl: args.adminUrl,
    });
    await this.sendMerchantNotice(
      storeId,
      { to, subject, content, language: lang },
      { queue: true }
    );
  }

  static async sendWholesaleNotice(
    storeId: string,
    args: {
      to: string;
      kind: WholesaleNoticeKind;
      customerName: string;
      businessName: string;
      note?: string | null;
      language?: 'en' | 'ar';
    }
  ): Promise<void> {
    if (!args.to) return;
    const store = await withStore(storeId, tx =>
      tx.store.findUnique({ where: { id: storeId }, select: { name: true, settings: true } })
    );
    if (!store) throw new Error(`Store ${storeId} not found`);
    const lang: 'en' | 'ar' =
      args.language ??
      resolveDefaultLanguage(
        (store.settings as { defaultLanguage?: string } | null)?.defaultLanguage
      );
    const { subject, content } = wholesaleNotice(args.kind, lang, {
      customerName: args.customerName,
      storeName: store.name,
      businessName: args.businessName,
      note: args.note,
    });
    await this.sendForStore(
      storeId,
      { to: args.to, subject, content, language: lang },
      { queue: true }
    );
  }

  /**
   * The customer's notice when an order is cancelled before any refund has
   * moved (issue 1948): "You were not charged." when the payment was never
   * captured, "Your refund is being processed." when it was (`data.charged`).
   */
  static async sendOrderCancelledNotCharged(
    storeId: string,
    data: OrderCancelledEmailData,
    language?: 'en' | 'ar'
  ): Promise<void> {
    if (!data.customerEmail) return;
    const store = await withStore(storeId, tx =>
      tx.store.findUnique({
        where: { id: storeId },
        select: { name: true, settings: true },
      })
    );
    if (!store) throw new Error(`Store ${storeId} not found`);
    const lang: 'en' | 'ar' =
      language ??
      resolveDefaultLanguage(
        (store.settings as { defaultLanguage?: string } | null)?.defaultLanguage
      );
    await this.sendForStore(
      storeId,
      {
        to: data.customerEmail,
        subject: orderCancelledNotChargedTemplate.subject[lang](data),
        content: orderCancelledNotChargedTemplate[lang](data),
        language: lang,
      },
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
    const store = await withStore(storeId, tx =>
      tx.store.findUnique({
        where: { id: storeId },
        select: { name: true, settings: true },
      })
    );
    if (!store) throw new Error(`Store ${storeId} not found`);
    const lang: 'en' | 'ar' =
      language ??
      resolveDefaultLanguage(
        (store.settings as { defaultLanguage?: string } | null)?.defaultLanguage
      );
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
    const store = await withStore(storeId, tx =>
      tx.store.findUnique({
        where: { id: storeId },
        select: { name: true, settings: true },
      })
    );
    if (!store) throw new Error(`Store ${storeId} not found`);
    const lang: 'en' | 'ar' =
      language ??
      resolveDefaultLanguage(
        (store.settings as { defaultLanguage?: string } | null)?.defaultLanguage
      );
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
    const store = await withStore(storeId, tx =>
      tx.store.findUnique({
        where: { id: storeId },
        select: { name: true, settings: true },
      })
    );
    if (!store) throw new Error(`Store ${storeId} not found`);
    const lang: 'en' | 'ar' =
      language ??
      resolveDefaultLanguage(
        (store.settings as { defaultLanguage?: string } | null)?.defaultLanguage
      );
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
    const store = await withStore(storeId, tx =>
      tx.store.findUnique({
        where: { id: storeId },
        select: { name: true, settings: true },
      })
    );
    if (!store) throw new Error(`Store ${storeId} not found`);
    const lang: 'en' | 'ar' =
      language ??
      resolveDefaultLanguage(
        (store.settings as { defaultLanguage?: string } | null)?.defaultLanguage
      );
    const subject = passwordResetTemplate.subject[lang](data, store.name);
    const content = passwordResetTemplate[lang](data, store.name);
    await this.sendForStore(storeId, { to: data.email, subject, content, language: lang });
  }

  /**
   * Passkey security notice to a SHOPPER, sent from the store's own sender identity (Ruling PASSKEY-16).
   * Never queued or skipped: it is an account-security message.
   */
  static async sendPasskeyNotice(
    storeId: string,
    data: PasskeyNoticeData,
    language: 'en' | 'ar'
  ): Promise<void> {
    await this.sendForStore(storeId, {
      to: data.email,
      subject: passkeyNoticeTemplate.subject[language](data),
      content: passkeyNoticeTemplate[language](data),
      language,
    });
  }

  /**
   * Welcome Email
   */
  static async sendWelcome(
    storeId: string,
    data: { email: string; name: string },
    language?: 'en' | 'ar'
  ): Promise<void> {
    const store = await withStore(storeId, tx =>
      tx.store.findUnique({
        where: { id: storeId },
        select: { name: true, settings: true },
      })
    );
    if (!store) throw new Error(`Store ${storeId} not found`);
    const lang: 'en' | 'ar' =
      language ??
      resolveDefaultLanguage(
        (store.settings as { defaultLanguage?: string } | null)?.defaultLanguage
      );
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
    const store = await withStore(storeId, tx =>
      tx.store.findUnique({
        where: { id: storeId },
        select: { name: true, settings: true },
      })
    );
    if (!store) throw new Error(`Store ${storeId} not found`);
    const lang: 'en' | 'ar' =
      language ??
      resolveDefaultLanguage(
        (store.settings as { defaultLanguage?: string } | null)?.defaultLanguage
      );
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
    const store = await withStore(storeId, tx =>
      tx.store.findUnique({
        where: { id: storeId },
        select: { name: true, settings: true },
      })
    );
    if (!store) throw new Error(`Store ${storeId} not found`);
    const lang: 'en' | 'ar' =
      language ??
      resolveDefaultLanguage(
        (store.settings as { defaultLanguage?: string } | null)?.defaultLanguage
      );
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
    const store = await withStore(storeId, tx =>
      tx.store.findUnique({
        where: { id: storeId },
        select: { name: true, settings: true },
      })
    );
    if (!store) throw new Error(`Store ${storeId} not found`);
    const lang: 'en' | 'ar' =
      language ??
      resolveDefaultLanguage(
        (store.settings as { defaultLanguage?: string } | null)?.defaultLanguage
      );
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
    const store = await withStore(storeId, tx =>
      tx.store.findUnique({
        where: { id: storeId },
        select: { name: true, settings: true },
      })
    );
    if (!store) throw new Error(`Store ${storeId} not found`);
    const lang: 'en' | 'ar' =
      language ??
      resolveDefaultLanguage(
        (store.settings as { defaultLanguage?: string } | null)?.defaultLanguage
      );
    const subject = returnConfirmationTemplate.subject[lang](data, store.name);
    const content = returnConfirmationTemplate[lang](data, store.name);
    // `queue: true` — same durable Redis retry path the order-lifecycle
    // emails use. The render (two Prisma reads) stays synchronous so it runs
    // inside the caller's tenant transaction; only the Resend call moves to
    // the queue drainer, where a transient failure retries 3x instead of
    // vanishing. Before this, the whole chain was fired-and-forgotten past
    // the response and died on a committed transaction (P2028) at
    // `store-mailer.service.ts` — every return confirmation silently unsent.
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
    const store = await withStore(storeId, tx =>
      tx.store.findUnique({
        where: { id: storeId },
        select: { name: true, settings: true },
      })
    );
    if (!store) throw new Error(`Store ${storeId} not found`);
    const lang: 'en' | 'ar' =
      language ??
      resolveDefaultLanguage(
        (store.settings as { defaultLanguage?: string } | null)?.defaultLanguage
      );
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
    const store = await withStore(storeId, tx =>
      tx.store.findUnique({
        where: { id: storeId },
        select: { name: true, settings: true },
      })
    );
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
    const store = await withStore(storeId, tx =>
      tx.store.findUnique({
        where: { id: storeId },
        select: { name: true, settings: true },
      })
    );
    const lang: 'en' | 'ar' =
      language ??
      resolveDefaultLanguage(
        (store?.settings as { defaultLanguage?: string } | null)?.defaultLanguage
      );
    const alertData = {
      items: data.items,
      storeName: data.storeName,
      adminUrl: data.adminUrl,
    };
    const subject = lowStockAlertTemplate.subject[lang](alertData);
    const content = lowStockAlertTemplate[lang](alertData);
    await this.sendMerchantNotice(storeId, { to: data.to, subject, content, language: lang });
  }

  /**
   * Merchant notice about the gold rate (Phase B5 Task 11): a stale-rate warning, the selling-paused
   * notice, or a pending automatic rate waiting for confirmation. Store default language.
   */
  static async sendGoldRateNotice(
    storeId: string,
    kind: GoldRateNoticeKind,
    data: GoldRateNoticeData & { to: string },
    language?: 'en' | 'ar'
  ): Promise<void> {
    const store = await withStore(storeId, tx =>
      tx.store.findUnique({ where: { id: storeId }, select: { settings: true } })
    );
    const lang: 'en' | 'ar' =
      language ??
      resolveDefaultLanguage(
        (store?.settings as { defaultLanguage?: string } | null)?.defaultLanguage
      );
    const tpl = GOLD_RATE_NOTICES[kind];
    await this.sendMerchantNotice(storeId, {
      to: data.to,
      subject: tpl.subject[lang](),
      content: tpl[lang](data),
      language: lang,
    });
  }

  /**
   * Merchant notice: the store passed its plan's monthly order cap (SP5).
   * Recipient is resolved by the caller (the store owner's email).
   */
  static async sendPlanLimitReached(
    storeId: string,
    data: PlanLimitReachedData & { to: string },
    language?: 'en' | 'ar'
  ): Promise<void> {
    const lang: 'en' | 'ar' = language ?? 'en';
    await this.sendMerchantNotice(storeId, {
      to: data.to,
      subject: planLimitReachedTemplate.subject[lang](data),
      content: planLimitReachedTemplate[lang](data),
      language: lang,
    });
  }

  /** Merchant notice: a webhook endpoint was switched off after repeated failures. */
  static async sendWebhookDisabledNotice(
    storeId: string,
    data: WebhookDisabledData & { to: string },
    language?: 'en' | 'ar'
  ): Promise<void> {
    const lang: 'en' | 'ar' = language ?? 'ar';
    await this.sendMerchantNotice(
      storeId,
      {
        to: data.to,
        subject: webhookDisabledTemplate.subject[lang](data),
        content: webhookDisabledTemplate[lang](data),
        language: lang,
      },
      { queue: true }
    );
  }

  /**
   * Merchant notice from the subscription dunning cycle (SP5 task 3): a failed
   * renewal with a retry scheduled, or the final downgrade to Free.
   */
  /** Add-on renewal notice (heads-up before the charge, or why it was not charged). Merchant notice, durable queue. */
  static async sendAddonNotice(
    storeId: string,
    to: string,
    copy: { title: string; body: string },
    billingUrl: string,
    lang: 'en' | 'ar'
  ): Promise<void> {
    const open = lang === 'ar' ? 'افتح الإضافات' : 'Open Add-ons';
    await this.sendMerchantNotice(
      storeId,
      {
        to,
        subject: copy.title,
        content: `<p>${escapeHtml(copy.body)}</p><p><a href="${escapeHtml(billingUrl)}">${open}</a></p>`,
        language: lang,
      },
      { queue: true }
    );
  }

  static async sendSubscriptionBillingNotice(
    storeId: string,
    data: SubscriptionBillingNoticeData & { to: string },
    language?: 'en' | 'ar'
  ): Promise<void> {
    const lang: 'en' | 'ar' = language ?? 'en';
    await this.sendMerchantNotice(
      storeId,
      {
        to: data.to,
        subject: subscriptionBillingTemplate.subject[lang](data),
        content: subscriptionBillingTemplate[lang](data),
        language: lang,
      },
      { queue: true }
    );
  }

  /**
   * Self-serve lifecycle email (setup nudges, trial recap, first-order referral ask) to the store owner.
   * Platform sender and Ebda shell (night/gold), through the durable queue. Refuses to send without an
   * unsubscribe link: consent is part of the contract, not of the template.
   */
  static async sendLifecycleEmail(
    data: LifecycleEmailData & { to: string },
    language: 'en' | 'ar' = 'ar'
  ): Promise<void> {
    if (!data.unsubscribeUrl) throw new Error('LIFECYCLE_EMAIL_NEEDS_UNSUBSCRIBE_URL');
    await this.sendPlatform(
      {
        to: data.to,
        subject: lifecycleTemplate.subject(data, language),
        content: lifecycleTemplate.content(data, language),
        language,
        replyTo: BRAND.supportEmail,
        headers: oneClickUnsubscribeHeaders(data.unsubscribeUrl),
      },
      { queue: true }
    );
  }

  // ---------------------------------------------------------------------------
  // Admin / platform-facing emails (no storeId — platform sender)
  // ---------------------------------------------------------------------------

  /**
   * Refund processed, to the STORE's order-notification address the caller resolved
   * (`settings.orderInvoiceEmail`; Ruling FU46-1a). Never Ebda's own address.
   */
  static async sendAdminRefund(data: {
    to: string;
    orderNumber: string;
    amount: number;
    reason?: string;
    currency?: string;
  }): Promise<void> {
    const content = this.adminRefundTemplate(data);
    await this.sendPlatform(
      {
        to: data.to,
        subject: `Refund Processed - Order #${data.orderNumber}`,
        content,
      },
      { queue: true }
    );
  }

  /**
   * A shopper's storefront contact message, to the STORE (Ruling FU46-1): from the store's own
   * sender, reply-to the shopper, in the store's branded shell.
   */
  static async sendStoreContactMessage(
    storeId: string,
    to: string,
    data: { name: string; email: string; subject: string; message: string }
  ): Promise<void> {
    await this.sendForStore(storeId, {
      to,
      subject: `Contact Form: ${oneLine(data.subject)}`,
      content: this.contactFormTemplate(data),
      replyTo: data.email,
    });
  }

  /**
   * A studio service enquiry from the public /contact form (Ruling CONTACT-FORM-1), to the studio inbox
   * (`BRAND.supportEmail`), reply-to the visitor. Sent directly, NOT through the retry queue: the caller
   * answers the visitor from this promise, so a failed send must reject (never claim success).
   */
  static async sendContactEnquiry(data: ContactEnquiryData): Promise<void> {
    await this.sendPlatform({
      to: BRAND.supportEmail,
      subject: `Studio enquiry: ${oneLine(data.topicLabel)} - ${oneLine(data.name)}`,
      content: contactEnquiryHtml(data),
      text: contactEnquiryText(data),
      replyTo: data.email,
      language: 'en',
    });
  }

  /** The visitor's short receipt for the enquiry above, in the language of the page they used. */
  static async sendContactEnquiryReceipt(
    to: string,
    data: Pick<ContactEnquiryData, 'name' | 'requestId' | 'lang'>
  ): Promise<void> {
    await this.sendPlatform({
      to,
      subject: contactEnquiryReceipt.subject[data.lang],
      content: contactEnquiryReceipt[data.lang](data),
      language: data.lang,
    });
  }

  // ---------------------------------------------------------------------------
  // Admin / internal template helpers — platform-only, not bilingual
  // ---------------------------------------------------------------------------

  /**
   * Admin New Order Template
   */
  private static adminRefundTemplate(d: {
    orderNumber: string;
    amount: number;
    reason?: string;
    currency?: string;
  }): string {
    return `
      <h2>Refund Processed</h2>
      <p><strong>Order #${escapeHtml(d.orderNumber)}</strong></p>
      <p><strong>Amount:</strong> ${emailMoney(d.amount, d.currency, 'en')}</p>
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
