import { prisma } from '@force/database';
import { config } from '../config';
import logger from '../lib/logger';
import { ResendService } from './resend.service';

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
  theme?: { primary?: string | null } | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  defaultLanguage?: 'en' | 'ar';
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
  const dir = store.defaultLanguage === 'ar' ? 'rtl' : 'ltr';
  const primary = sanitizeThemeColor(store.theme?.primary ?? null);
  const storeName = escapeHtml(store.name);
  const header = store.logo
    ? `<img src="${escapeHtml(store.logo)}" alt="${storeName}" style="max-height:48px;display:block;margin:0 auto;">`
    : `<h1>${storeName}</h1>`;
  const year = new Date().getFullYear();
  const footerLines: string[] = [];
  if (store.address) footerLines.push(escapeHtml(store.address));
  if (store.phone) footerLines.push(escapeHtml(store.phone));
  if (store.email) footerLines.push(escapeHtml(store.email));

  return `<!DOCTYPE html>
<html dir="${dir}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${storeName}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f5f5f5; }
    .container { max-width: 600px; margin: 0 auto; background: #ffffff; }
    .header { background: ${primary}; padding: 24px; text-align: center; }
    .header h1 { color: #ffffff; margin: 0; font-size: 24px; }
    .content { padding: 32px 24px; }
    .footer { background: #f5f5f5; padding: 24px; text-align: center; font-size: 12px; color: #666; }
    .button { display: inline-block; background: ${primary}; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 4px; font-weight: 600; }
    .order-table { width: 100%; border-collapse: collapse; margin: 16px 0; }
    .order-table th, .order-table td { padding: 12px; text-align: left; border-bottom: 1px solid #eee; }
    .order-table th { background: #f9f9f9; }
    .total-row { font-weight: 600; font-size: 18px; }
    .address-box { background: #f9f9f9; padding: 16px; border-radius: 4px; margin: 16px 0; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">${header}</div>
    <div class="content">${content}</div>
    <div class="footer">
      <p>© ${year} ${storeName}. All rights reserved.</p>
      ${footerLines.map(l => `<p>${l}</p>`).join('\n      ')}
      <p style="margin-top:12px;font-size:11px;color:#999;">Powered by Force Store</p>
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
    quantity: number;
    price: number;
  }>;
  subtotal: number;
  tax: number;
  shipping: number;
  discount?: number;
  couponCode?: string;
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
    args: { to: string | string[]; subject: string; content: string; text?: string }
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
    const defaultLanguage =
      (store.settings as Record<string, unknown> | null)?.defaultLanguage === 'ar' ? 'ar' : 'en';
    const html = renderBrandedShell(args.content, {
      name: store.name,
      nameAr: store.nameAr,
      logo: store.logo,
      theme: store.theme as { primary?: string | null } | null,
      email: store.email,
      phone: store.phone,
      address: store.address,
      defaultLanguage,
    });
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
  private static async sendPlatform(args: {
    to: string | string[];
    subject: string;
    content: string;
    text?: string;
    replyTo?: string;
  }): Promise<void> {
    const html = renderBrandedShell(args.content, {
      name: 'Force Store',
      nameAr: null,
      logo: null,
      theme: null,
      email: null,
      phone: null,
      address: null,
      defaultLanguage: 'en',
    });
    const { Resend } = await import('resend');
    const r = new Resend(config.resendApiKey);
    const payload: Record<string, unknown> = {
      from: 'Force Store <noreply@forcemediakw.com>',
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
    const { Resend } = await import('resend');
    const r = new Resend(config.resendApiKey);
    const payload: Record<string, unknown> = {
      from: 'Force Store <noreply@forcemediakw.com>',
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
  static async sendOrderConfirmation(storeId: string, data: OrderEmailData): Promise<void> {
    const content = this.orderConfirmationTemplate(data);
    await this.sendForStore(storeId, {
      to: data.customerEmail,
      subject: `Order Confirmed - #${data.orderNumber}`,
      content,
    });
  }

  /**
   * Payment Success Email
   */
  static async sendPaymentSuccess(storeId: string, data: OrderEmailData): Promise<void> {
    const content = this.paymentSuccessTemplate(data);
    await this.sendForStore(storeId, {
      to: data.customerEmail,
      subject: `Payment Received - Order #${data.orderNumber}`,
      content,
    });
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
    }
  ): Promise<void> {
    const content = this.paymentFailedTemplate(data);
    await this.sendForStore(storeId, {
      to: data.customerEmail,
      subject: `Payment Failed - Order #${data.orderNumber}`,
      content,
    });
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
    }
  ): Promise<void> {
    const content = this.orderShippedTemplate(data);
    await this.sendForStore(storeId, {
      to: data.customerEmail,
      subject: `Your Order Has Shipped - #${data.orderNumber}`,
      content,
    });
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
      expiresIn: string;
    }
  ): Promise<void> {
    const content = this.passwordResetTemplate(data);
    await this.sendForStore(storeId, {
      to: data.email,
      subject: 'Reset Your Password',
      content,
    });
  }

  /**
   * Welcome Email
   */
  static async sendWelcome(storeId: string, data: { email: string; name: string }): Promise<void> {
    const content = this.welcomeTemplate(data);
    await this.sendForStore(storeId, {
      to: data.email,
      subject: 'Welcome to Force Store',
      content,
    });
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
      expiresIn: string;
    }
  ): Promise<void> {
    const content = this.emailVerificationTemplate(data);
    await this.sendForStore(storeId, {
      to: data.email,
      subject: 'Verify Your Email Address',
      content,
    });
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
    }
  ): Promise<void> {
    const content = this.duplicateRegistrationTemplate(data);
    await this.sendForStore(storeId, {
      to: data.email,
      subject:
        data.storeName && data.storeName.length > 0
          ? `Account already exists at ${data.storeName}`
          : 'Account already exists',
      content,
    });
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
      expiresIn: string;
    }
  ): Promise<void> {
    const content = this.resendVerificationTemplate(data);
    await this.sendForStore(storeId, {
      to: data.email,
      subject: 'Verify Your Email Address - New Link',
      content,
    });
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
    }
  ) {
    const typeLabel =
      data.type === 'exchange' ? 'Exchange' : data.type === 'refund' ? 'Refund' : 'Return';
    const content = this.returnConfirmationTemplate(data);
    await this.sendForStore(storeId, {
      to: data.email,
      subject: `${typeLabel} Request Received - #${data.returnNumber}`,
      content,
    });
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
    }
  ) {
    const content = this.returnStatusUpdateTemplate(data);
    await this.sendForStore(storeId, {
      to: data.email,
      subject: `Return Status Update - #${data.returnNumber}`,
      content,
    });
  }

  /**
   * Send invoice email to customer.
   */
  static async sendInvoice(
    storeId: string,
    data: { to: string | string[]; orderNumber: string; html: string }
  ): Promise<void> {
    await this.sendForStore(storeId, {
      to: data.to,
      subject: `Invoice ${data.orderNumber}`,
      content: data.html,
    });
  }

  // ---------------------------------------------------------------------------
  // Admin / platform-facing emails (no storeId — platform sender)
  // ---------------------------------------------------------------------------

  /**
   * Admin Alert: New Order
   */
  static async sendAdminNewOrder(data: OrderEmailData): Promise<void> {
    const content = this.adminNewOrderTemplate(data);
    await this.sendPlatform({
      to: config.smtpFromEmail,
      subject: `New Order Received - #${data.orderNumber}`,
      content,
    });
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
    await this.sendPlatform({
      to: config.smtpFromEmail,
      subject: `Refund Processed - Order #${data.orderNumber}`,
      content,
    });
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
          name: 'Force Store',
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
  // Template renderers — return inner content only (no shell wrapper)
  // ---------------------------------------------------------------------------

  /**
   * Render email template — returns inner content only.
   */
  private static renderTemplate(templateName: string, data: object): string {
    const templates: Record<string, (data: object) => string> = {
      'order-confirmation': d => this.orderConfirmationTemplate(d as OrderEmailData),
      'payment-success': d => this.paymentSuccessTemplate(d as OrderEmailData),
      'payment-failed': d =>
        this.paymentFailedTemplate(
          d as { customerEmail: string; customerName: string; orderNumber: string; reason?: string }
        ),
      'order-shipped': d =>
        this.orderShippedTemplate(
          d as {
            customerEmail: string;
            customerName: string;
            orderNumber: string;
            trackingNumber?: string;
            trackingUrl?: string;
            carrier?: string;
          }
        ),
      'password-reset': d =>
        this.passwordResetTemplate(
          d as { email: string; name: string; resetUrl: string; expiresIn: string }
        ),
      welcome: d => this.welcomeTemplate(d as { email: string; name: string }),
      'email-verification': d =>
        this.emailVerificationTemplate(
          d as { email: string; name: string; verificationUrl: string; expiresIn: string }
        ),
      'resend-verification': d =>
        this.resendVerificationTemplate(
          d as { email: string; name: string; verificationUrl: string; expiresIn: string }
        ),
      'duplicate-registration': d =>
        this.duplicateRegistrationTemplate(
          d as { email: string; name: string; storeName?: string }
        ),
      'admin-new-order': d => this.adminNewOrderTemplate(d as OrderEmailData),
      'admin-refund': d =>
        this.adminRefundTemplate(d as { orderNumber: string; amount: number; reason?: string }),
      'contact-form': d =>
        this.contactFormTemplate(
          d as { name: string; email: string; subject: string; message: string }
        ),
    };

    const template = templates[templateName];
    if (!template) {
      throw new Error(`Email template not found: ${templateName}`);
    }

    return template(data);
  }

  /**
   * Order Confirmation Template
   */
  private static orderConfirmationTemplate(d: OrderEmailData): string {
    const itemsHtml = d.items
      .map(
        item => `
      <tr>
        <td>${escapeHtml(item.name)}</td>
        <td style="text-align: center;">${item.quantity}</td>
        <td style="text-align: right;">${(item.price / 1000).toFixed(3)} KWD</td>
      </tr>
    `
      )
      .join('');

    return `
      <h2>Thank you for your order!</h2>
      <p>Hi ${escapeHtml(d.customerName)},</p>
      <p>We've received your order and are getting it ready. We'll notify you when it ships.</p>

      <h3>Order #${escapeHtml(d.orderNumber)}</h3>

      <table class="order-table">
        <thead>
          <tr>
            <th>Item</th>
            <th style="text-align: center;">Qty</th>
            <th style="text-align: right;">Price</th>
          </tr>
        </thead>
        <tbody>
          ${itemsHtml}
        </tbody>
        <tfoot>
          <tr>
            <td colspan="2">Subtotal</td>
            <td style="text-align: right;">${(d.subtotal / 1000).toFixed(3)} KWD</td>
          </tr>
          <tr>
            <td colspan="2">Tax</td>
            <td style="text-align: right;">${(d.tax / 1000).toFixed(3)} KWD</td>
          </tr>
          <tr>
            <td colspan="2">Shipping</td>
            <td style="text-align: right;">${(d.shipping / 1000).toFixed(3)} KWD</td>
          </tr>
          ${
            d.discount && d.discount > 0
              ? `<tr>
            <td colspan="2">Discount${d.couponCode ? ` (${escapeHtml(d.couponCode)})` : ''}</td>
            <td style="text-align: right;">-${(d.discount / 1000).toFixed(3)} KWD</td>
          </tr>`
              : ''
          }
          <tr class="total-row">
            <td colspan="2">Total</td>
            <td style="text-align: right;">${(d.total / 1000).toFixed(3)} KWD</td>
          </tr>
        </tfoot>
      </table>

      <div class="address-box">
        <strong>Shipping Address</strong><br>
        ${escapeHtml(d.shippingAddress.firstName)} ${escapeHtml(d.shippingAddress.lastName)}<br>
        ${escapeHtml(d.shippingAddress.address1)}<br>
        ${d.shippingAddress.address2 ? escapeHtml(d.shippingAddress.address2) + '<br>' : ''}
        ${escapeHtml(d.shippingAddress.city)}, ${escapeHtml(d.shippingAddress.state)} ${escapeHtml(d.shippingAddress.postalCode)}<br>
        ${escapeHtml(d.shippingAddress.country)}
      </div>

      <p>If you have any questions, please reply to this email.</p>
    `;
  }

  /**
   * Payment Success Template
   */
  private static paymentSuccessTemplate(d: OrderEmailData): string {
    return `
      <h2>Payment Received</h2>
      <p>Hi ${escapeHtml(d.customerName)},</p>
      <p>We've successfully processed your payment of <strong>${(d.total / 1000).toFixed(3)} KWD</strong> for order #${escapeHtml(d.orderNumber)}.</p>
      <p>Your order is now being prepared for shipment.</p>
      <p>Thank you for shopping with us!</p>
    `;
  }

  /**
   * Payment Failed Template
   */
  private static paymentFailedTemplate(d: {
    customerEmail: string;
    customerName: string;
    orderNumber: string;
    reason?: string;
  }): string {
    return `
      <h2>Payment Failed</h2>
      <p>Hi ${escapeHtml(d.customerName)},</p>
      <p>Unfortunately, we were unable to process your payment for order #${escapeHtml(d.orderNumber)}.</p>
      ${d.reason ? `<p><strong>Reason:</strong> ${escapeHtml(d.reason)}</p>` : ''}
      <p>Please update your payment information or try a different payment method.</p>
      <p style="text-align: center; margin: 24px 0;">
        <a href="${config.webUrl}/checkout" class="button">Retry Payment</a>
      </p>
    `;
  }

  /**
   * Order Shipped Template
   */
  private static orderShippedTemplate(d: {
    customerEmail: string;
    customerName: string;
    orderNumber: string;
    trackingNumber?: string;
    trackingUrl?: string;
    carrier?: string;
  }): string {
    return `
      <h2>Your Order Has Shipped!</h2>
      <p>Hi ${escapeHtml(d.customerName)},</p>
      <p>Great news! Your order #${escapeHtml(d.orderNumber)} is on its way.</p>
      ${d.carrier ? `<p><strong>Carrier:</strong> ${escapeHtml(d.carrier)}</p>` : ''}
      ${d.trackingNumber ? `<p><strong>Tracking Number:</strong> ${escapeHtml(d.trackingNumber)}</p>` : ''}
      ${
        d.trackingUrl
          ? `
        <p style="text-align: center; margin: 24px 0;">
          <a href="${escapeHtml(d.trackingUrl)}" class="button">Track Your Order</a>
        </p>
      `
          : ''
      }
      <p>Thank you for shopping with us!</p>
    `;
  }

  /**
   * Password Reset Template
   */
  private static passwordResetTemplate(d: {
    email: string;
    name: string;
    resetUrl: string;
    expiresIn: string;
  }): string {
    return `
      <h2>Reset Your Password</h2>
      <p>Hi ${escapeHtml(d.name)},</p>
      <p>We received a request to reset your password. Click the button below to create a new password:</p>
      <p style="text-align: center; margin: 24px 0;">
        <a href="${escapeHtml(d.resetUrl)}" class="button">Reset Password</a>
      </p>
      <p>This link will expire in ${escapeHtml(d.expiresIn)}.</p>
      <p>If you didn't request this, you can safely ignore this email.</p>
    `;
  }

  /**
   * Welcome Template
   */
  private static welcomeTemplate(d: { email: string; name: string }): string {
    return `
      <h2>Welcome!</h2>
      <p>Hi ${escapeHtml(d.name)},</p>
      <p>Thank you for creating an account with us. We're excited to have you!</p>
      <p>You can now:</p>
      <ul>
        <li>Browse our catalog of products</li>
        <li>Save items to your wishlist</li>
        <li>Track your orders</li>
        <li>Get exclusive offers</li>
      </ul>
      <p style="text-align: center; margin: 24px 0;">
        <a href="${config.webUrl}/products" class="button">Start Shopping</a>
      </p>
    `;
  }

  /**
   * Email Verification Template
   */
  private static emailVerificationTemplate(d: {
    email: string;
    name: string;
    verificationUrl: string;
    expiresIn: string;
  }): string {
    const verificationUrlEsc = escapeHtml(d.verificationUrl);
    return `
      <h2>Verify Your Email Address</h2>
      <p>Hi ${escapeHtml(d.name)},</p>
      <p>Thank you for registering! Please verify your email address to complete your account setup.</p>
      <p style="text-align: center; margin: 24px 0;">
        <a href="${verificationUrlEsc}" class="button">Verify Email</a>
      </p>
      <p>This link will expire in ${escapeHtml(d.expiresIn)}.</p>
      <p style="font-size: 14px; color: #666;">If you didn't create an account, you can safely ignore this email.</p>
      <p style="font-size: 12px; color: #999; margin-top: 24px;">
        If the button above doesn't work, copy and paste this link into your browser:<br>
        <a href="${verificationUrlEsc}" style="color: #ff6e00; word-break: break-all;">${verificationUrlEsc}</a>
      </p>
    `;
  }

  /**
   * Resend Email Verification Template
   */
  private static resendVerificationTemplate(d: {
    email: string;
    name: string;
    verificationUrl: string;
    expiresIn: string;
  }): string {
    const verificationUrlEsc = escapeHtml(d.verificationUrl);
    return `
      <h2>New Verification Link</h2>
      <p>Hi ${escapeHtml(d.name)},</p>
      <p>Here's your new email verification link as requested.</p>
      <p style="text-align: center; margin: 24px 0;">
        <a href="${verificationUrlEsc}" class="button">Verify Email</a>
      </p>
      <p>This link will expire in ${escapeHtml(d.expiresIn)}.</p>
      <p style="font-size: 14px; color: #666;">If you didn't request this, please contact support.</p>
      <p style="font-size: 12px; color: #999; margin-top: 24px;">
        If the button above doesn't work, copy and paste this link into your browser:<br>
        <a href="${verificationUrlEsc}" style="color: #ff6e00; word-break: break-all;">${verificationUrlEsc}</a>
      </p>
    `;
  }

  /**
   * Duplicate Registration Notice template.
   */
  private static duplicateRegistrationTemplate(d: {
    email: string;
    name: string;
    storeName?: string;
  }): string {
    const loginUrlEsc = escapeHtml(`${config.webUrl}/auth/login`);
    const resetUrlEsc = escapeHtml(`${config.webUrl}/auth/forgot-password`);
    const storeRef = d.storeName ? ` at ${escapeHtml(d.storeName)}` : '';
    return `
      <h2>Account already exists</h2>
      <p>Hi ${escapeHtml(d.name)},</p>
      <p>
        Someone (possibly you) just tried to register a new account${storeRef}
        using this email address — but you already have an account here.
      </p>
      <p>
        If this was you, just sign in normally:
      </p>
      <p style="text-align: center; margin: 24px 0;">
        <a href="${loginUrlEsc}" class="button">Sign in</a>
      </p>
      <p>
        If you've forgotten your password, you can
        <a href="${resetUrlEsc}" style="color: #ff6e00;">request a reset link</a>.
      </p>
      <p style="font-size: 14px; color: #666; margin-top: 24px;">
        If this wasn't you, you can ignore this email — no changes were
        made to your account. We recommend resetting your password if
        you think someone else has your email address.
      </p>
    `;
  }

  /**
   * Admin New Order Template
   */
  private static adminNewOrderTemplate(d: OrderEmailData): string {
    return `
      <h2>New Order Received</h2>
      <p><strong>Order #${escapeHtml(d.orderNumber)}</strong></p>
      <p><strong>Customer:</strong> ${escapeHtml(d.customerName)} (${escapeHtml(d.customerEmail)})</p>
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
   * Return Confirmation Template
   */
  private static returnConfirmationTemplate(d: {
    customerName: string;
    storeName: string;
    returnNumber: string;
    orderNumber: string;
    type: string;
  }): string {
    const typeLabel =
      d.type === 'exchange' ? 'Exchange' : d.type === 'refund' ? 'Refund' : 'Return';
    return `
      <h2>${typeLabel} Request Received</h2>
      <p>Hi ${escapeHtml(d.customerName)},</p>
      <p>We have received your ${typeLabel.toLowerCase()} request for order #${escapeHtml(d.orderNumber)}.</p>
      <p><strong>${typeLabel} Number:</strong> ${escapeHtml(d.returnNumber)}</p>
      <p>Our team will review your request and get back to you within 1-2 business days.</p>
      <p style="font-size: 14px; color: #666; margin-top: 24px;">
        If you have any questions, please don't hesitate to contact our support team.
      </p>
      <p style="margin-top: 24px;">Thank you for your patience!</p>
      <p>Best regards,<br>${escapeHtml(d.storeName)} Team</p>
    `;
  }

  /**
   * Return Status Update Template
   */
  private static returnStatusUpdateTemplate(d: {
    customerName: string;
    storeName: string;
    returnNumber: string;
    status: string;
    notes?: string;
  }): string {
    const statusMessages: Record<string, string> = {
      approved:
        'Your return request has been approved! Please ship the items back to us using the provided instructions.',
      rejected: 'Unfortunately, we were unable to approve your return request.',
      shipped: 'We have noted that your return items have been shipped.',
      received: 'We have received your returned items and they are being inspected.',
      inspecting: 'Your items are currently being inspected by our team.',
      completed: 'Your return has been completed and your refund has been processed.',
      cancelled: 'Your return request has been cancelled.',
    };

    const message =
      statusMessages[d.status] ||
      `Your return request status has been updated to: ${escapeHtml(d.status)}`;

    return `
      <h2>Return Status Update</h2>
      <p>Hi ${escapeHtml(d.customerName)},</p>
      <p><strong>Return Number:</strong> ${escapeHtml(d.returnNumber)}</p>
      <p>${message}</p>
      ${d.notes ? `<p><strong>Note from our team:</strong> ${escapeHtml(d.notes)}</p>` : ''}
      <p style="font-size: 14px; color: #666; margin-top: 24px;">
        If you have any questions, please contact our support team.
      </p>
      <p>Best regards,<br>${escapeHtml(d.storeName)} Team</p>
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
      <div style="background: #f9f9f9; padding: 16px; border-radius: 4px; margin: 16px 0; white-space: pre-wrap;">${escapeHtml(d.message)}</div>
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

  // renderTemplate kept for any internal legacy callers (not used in new send paths)
  /** @internal */
  static _renderTemplateForTest(templateName: string, data: object): string {
    return this.renderTemplate(templateName, data);
  }
}
