import { prisma } from '@force/database';
import { AppError } from '../middleware/error-handler';

/**
 * Escape special HTML characters to prevent stored XSS attacks.
 * Must be applied to every user-supplied value interpolated into HTML.
 */
function escapeHtml(value: string | null | undefined): string {
  if (value == null) return '';
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/**
 * Read a brand color from the store's theme JSON. Theme stores HSL components
 * (e.g. "26 100% 50%") matching the Tailwind theme-token format. Returns a
 * complete `hsl(...)` string; falls back to Force Orange when no color set.
 */
function readBrandColor(theme: unknown, fallback = 'hsl(26 100% 50%)'): string {
  if (theme && typeof theme === 'object' && 'primaryColor' in theme) {
    const v = (theme as { primaryColor?: unknown }).primaryColor;
    if (typeof v === 'string' && v.trim()) return `hsl(${v})`;
  }
  return fallback;
}

export class InvoiceService {
  /**
   * Generate HTML invoice for an order. Themed with the store's brand color
   * so each tenant's invoice matches their storefront. Print-optimized; hides
   * the print button on @media print.
   */
  static async generateInvoice(storeId: string, orderId: string): Promise<string> {
    const order = await prisma.order.findFirst({
      where: { id: orderId, storeId },
      include: {
        store: {
          select: {
            name: true,
            email: true,
            phone: true,
            address: true,
            logo: true,
            theme: true,
            currency: true,
            timezone: true,
          },
        },
        customer: { select: { email: true, firstName: true, lastName: true } },
        items: { include: { product: { include: { images: { take: 1 } } } } },
        payments: { where: { status: 'completed' }, take: 1 },
      },
    });

    if (!order) {
      throw new AppError(404, 'NOT_FOUND', 'Order not found');
    }

    const currency = order.store.currency || 'KWD';
    const formatPrice = (fils: number) => `${(fils / 1000).toFixed(3)} ${currency}`;
    const shippingAddr = order.shippingAddress as Record<string, string> | null;
    // Bill To should reflect the buyer info entered in checkout, not the
    // authenticated account (a logged-in admin testing checkout would otherwise
    // see their admin name on every invoice). Billing falls back to shipping
    // when the storefront didn't collect a separate billing address.
    const billingAddr = (order.billingAddress as Record<string, string> | null) ?? shippingAddr;
    const payment = order.payments?.[0];
    const brand = readBrandColor(order.store.theme);

    const isPaid = order.paymentStatus === 'paid';
    const isCancelled = order.status === 'cancelled';
    const isRefunded = order.paymentStatus === 'refunded' || order.status === 'refunded';

    const statusLabel = isCancelled
      ? 'CANCELLED'
      : isRefunded
        ? 'REFUNDED'
        : isPaid
          ? 'PAID'
          : (order.paymentStatus || 'UNPAID').toUpperCase();
    const statusClass = isCancelled
      ? 'cancelled'
      : isRefunded
        ? 'refunded'
        : isPaid
          ? 'paid'
          : 'unpaid';

    // Render the invoice date in the store's timezone so a Kuwait merchant's
    // invoice doesn't show the UTC day on edge-of-midnight orders. Falls back
    // to Asia/Kuwait when a tenant hasn't set a timezone yet (matches the
    // storefront default).
    const dateText = new Date(order.createdAt).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: order.store.timezone || 'Asia/Kuwait',
    });

    const itemsHtml = order.items
      .map((item, i) => {
        const image = item.product?.images?.[0]?.url;
        return `
          <tr>
            <td class="col-num">${i + 1}</td>
            <td class="col-item">
              <div class="item-cell">
                ${
                  image
                    ? `<img src="${escapeHtml(image)}" alt="" class="item-thumb" loading="lazy" />`
                    : '<div class="item-thumb item-thumb-placeholder"></div>'
                }
                <div class="item-meta">
                  <div class="item-name">${escapeHtml(item.productName)}${item.variantName ? ` &middot; ${escapeHtml(item.variantName)}` : ''}</div>
                  ${item.sku ? `<div class="item-sku">${escapeHtml(item.sku)}</div>` : ''}
                </div>
              </div>
            </td>
            <td class="col-qty">${item.quantity}</td>
            <td class="col-price">${formatPrice(item.price)}</td>
            <td class="col-total">${formatPrice(item.total)}</td>
          </tr>`;
      })
      .join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Invoice ${escapeHtml(order.orderNumber)} &middot; ${escapeHtml(order.store.name)}</title>
  <style>
    :root {
      --brand: ${brand};
      --ink: #0f172a;
      --ink-soft: #475569;
      --ink-mute: #94a3b8;
      --line: #e2e8f0;
      --line-soft: #f1f5f9;
      --bg: #ffffff;
      --bg-soft: #f8fafc;
      --success: #16a34a;
      --success-bg: #dcfce7;
      --warning: #ca8a04;
      --warning-bg: #fef9c3;
      --danger: #dc2626;
      --danger-bg: #fee2e2;
      --info: #0284c7;
      --info-bg: #e0f2fe;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { background: var(--bg-soft); }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      color: var(--ink);
      line-height: 1.5;
      font-size: 14px;
      -webkit-font-smoothing: antialiased;
    }
    .page {
      max-width: 880px;
      margin: 32px auto;
      background: var(--bg);
      border-radius: 16px;
      overflow: hidden;
      box-shadow: 0 1px 3px rgba(0,0,0,0.04), 0 8px 24px rgba(15,23,42,0.06);
      position: relative;
    }
    .ribbon {
      height: 6px;
      background: linear-gradient(90deg, var(--brand) 0%, color-mix(in srgb, var(--brand) 70%, white 30%) 100%);
    }
    .pad { padding: 44px 52px; position: relative; z-index: 1; }
    /* Subtle header backdrop — uses the brand color at very low alpha */
    .header-bg {
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 220px;
      background: linear-gradient(180deg, color-mix(in srgb, var(--brand) 4%, white 96%) 0%, transparent 100%);
      pointer-events: none;
      z-index: 0;
    }
    /* Diagonal status stamp — pure CSS, prints faithfully */
    .stamp {
      position: absolute;
      top: 38%; left: 50%;
      transform: translate(-50%, -50%) rotate(-18deg);
      font-size: 96px; font-weight: 900;
      letter-spacing: 0.08em;
      pointer-events: none;
      z-index: 0;
      opacity: 0.06;
      white-space: nowrap;
      user-select: none;
    }
    .stamp.paid { color: var(--success); }
    .stamp.unpaid { color: var(--warning); }
    .stamp.cancelled, .stamp.refunded { color: var(--danger); }

    /* Header */
    .header { display: flex; align-items: flex-start; justify-content: space-between; gap: 32px; padding-bottom: 32px; border-bottom: 1px solid var(--line); }
    .store-info { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
    .store-logo { max-height: 72px; max-width: 240px; object-fit: contain; margin-bottom: 8px; }
    .store-name { font-size: 22px; font-weight: 700; color: var(--ink); letter-spacing: -0.01em; }
    .store-meta { font-size: 12px; color: var(--ink-soft); }
    .invoice-side { text-align: right; flex-shrink: 0; }
    .invoice-eyebrow { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.18em; color: var(--brand); }
    .invoice-number { font-size: 22px; font-weight: 800; color: var(--ink); margin-top: 6px; font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
    .invoice-date { font-size: 12px; color: var(--ink-soft); margin-top: 4px; }
    .badge { display: inline-flex; align-items: center; gap: 6px; margin-top: 10px; padding: 6px 12px; border-radius: 999px; font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
    .badge::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
    .badge.paid { background: var(--success-bg); color: var(--success); }
    .badge.unpaid { background: var(--warning-bg); color: var(--warning); }
    .badge.cancelled, .badge.refunded { background: var(--danger-bg); color: var(--danger); }

    /* Address blocks */
    .addresses { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; padding: 28px 0; border-bottom: 1px solid var(--line); }
    .addr-card { background: var(--bg-soft); border-radius: 12px; padding: 18px 20px; }
    .addr-label { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.12em; color: var(--ink-mute); margin-bottom: 8px; }
    .addr-name { font-size: 15px; font-weight: 600; color: var(--ink); margin-bottom: 6px; }
    .addr-line { font-size: 13px; color: var(--ink-soft); line-height: 1.55; }

    /* Payment row */
    .payment-row { display: flex; align-items: center; gap: 12px; margin-top: 24px; padding: 14px 18px; background: var(--info-bg); color: var(--info); border-radius: 10px; font-size: 13px; }
    .payment-row strong { font-weight: 600; }

    /* Items table */
    .items-wrap { padding: 28px 0 0; }
    table { width: 100%; border-collapse: collapse; }
    thead th {
      text-align: left;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: var(--ink-mute);
      padding: 12px 12px;
      border-bottom: 1px solid var(--line);
    }
    tbody td { padding: 16px 12px; border-bottom: 1px solid var(--line-soft); vertical-align: middle; }
    tbody tr:last-child td { border-bottom: 0; }
    .col-num { width: 36px; color: var(--ink-mute); font-variant-numeric: tabular-nums; }
    .col-qty { text-align: right; width: 60px; font-variant-numeric: tabular-nums; }
    .col-price { text-align: right; width: 120px; color: var(--ink-soft); font-variant-numeric: tabular-nums; }
    .col-total { text-align: right; width: 130px; font-weight: 600; font-variant-numeric: tabular-nums; }
    thead th.col-qty, thead th.col-price, thead th.col-total { text-align: right; }
    .item-cell { display: flex; align-items: center; gap: 12px; }
    .item-thumb { width: 44px; height: 44px; border-radius: 8px; object-fit: cover; background: var(--bg-soft); flex-shrink: 0; }
    .item-thumb-placeholder { background: var(--line-soft); }
    .item-meta { min-width: 0; }
    .item-name { font-weight: 500; color: var(--ink); }
    .item-sku { font-size: 11px; color: var(--ink-mute); margin-top: 2px; font-variant-numeric: tabular-nums; }

    /* Totals */
    .totals-wrap { display: flex; justify-content: flex-end; padding: 20px 0 0; }
    .totals { width: 320px; }
    .totals .row { display: flex; justify-content: space-between; align-items: baseline; padding: 8px 0; font-size: 14px; }
    .totals .row .label { color: var(--ink-soft); }
    .totals .row .val { color: var(--ink); font-variant-numeric: tabular-nums; }
    .totals .discount .val { color: var(--success); }
    .totals .grand {
      margin-top: 10px; padding: 14px 16px;
      background: color-mix(in srgb, var(--brand) 8%, white 92%);
      border-radius: 10px;
      border-left: 3px solid var(--brand);
      font-size: 18px; font-weight: 800;
    }
    .totals .grand .val { color: var(--brand); font-size: 22px; }

    /* Notes */
    .notes { margin-top: 28px; padding: 18px 20px; background: var(--bg-soft); border-radius: 12px; }
    .notes .label { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.1em; color: var(--ink-mute); margin-bottom: 6px; }
    .notes .body { font-size: 13px; color: var(--ink); line-height: 1.55; white-space: pre-wrap; }

    /* Footer */
    .footer { margin-top: 36px; padding-top: 24px; border-top: 1px solid var(--line); display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; flex-wrap: wrap; }
    .footer-text { font-size: 12px; color: var(--ink-mute); line-height: 1.6; flex: 1; min-width: 200px; }
    .footer-thank { font-weight: 600; color: var(--ink-soft); margin-bottom: 4px; }
    .footer-contact { font-size: 11px; color: var(--ink-mute); line-height: 1.6; text-align: right; }

    /* Actions */
    .actions { text-align: center; padding: 0 0 36px; }
    .btn-print {
      display: inline-flex; align-items: center; gap: 8px;
      background: var(--brand); color: #fff;
      border: none; padding: 12px 24px; border-radius: 10px;
      cursor: pointer; font-size: 14px; font-weight: 600;
      box-shadow: 0 4px 12px rgba(15,23,42,0.12);
      transition: transform 0.15s, box-shadow 0.15s;
    }
    .btn-print:hover { transform: translateY(-1px); box-shadow: 0 6px 16px rgba(15,23,42,0.16); }
    .btn-print:active { transform: translateY(0); }

    /* Print */
    @media print {
      html, body { background: #fff; }
      body { font-size: 12px; }
      .page { box-shadow: none; border-radius: 0; margin: 0; max-width: none; }
      .pad { padding: 24px 28px; }
      .ribbon { display: none; }
      .no-print { display: none !important; }
      .addr-card, .payment-row, .notes { background: #fff; border: 1px solid var(--line); }
      .item-thumb { width: 36px; height: 36px; }
      a { color: inherit; text-decoration: none; }
    }

    @media (max-width: 640px) {
      .pad { padding: 24px; }
      .header { flex-direction: column; gap: 16px; }
      .invoice-side { text-align: left; }
      .addresses { grid-template-columns: 1fr; }
      .totals { width: 100%; }
      .col-num { display: none; }
      thead th.col-num { display: none; }
    }
  </style>
</head>
<body>
  <div class="page">
    <div class="ribbon"></div>
    <div class="header-bg" aria-hidden="true"></div>
    <div class="stamp ${statusClass}" aria-hidden="true">${escapeHtml(statusLabel)}</div>

    <div class="pad">
      <header class="header">
        <div class="store-info">
          ${
            order.store.logo
              ? // Logo is the brand mark — when present we don't also render
                // the store-name text below it; otherwise the name shows up
                // twice (e.g. logo of "Wady Aljuz" + text "Wady Aljuz").
                `<img src="${escapeHtml(order.store.logo)}" alt="${escapeHtml(order.store.name)}" class="store-logo" />`
              : `<div class="store-name">${escapeHtml(order.store.name)}</div>`
          }
          ${order.store.email ? `<div class="store-meta">${escapeHtml(order.store.email)}</div>` : ''}
          ${order.store.phone ? `<div class="store-meta">${escapeHtml(order.store.phone)}</div>` : ''}
          ${order.store.address ? `<div class="store-meta">${escapeHtml(order.store.address)}</div>` : ''}
        </div>
        <div class="invoice-side">
          <div class="invoice-eyebrow">Invoice</div>
          <div class="invoice-number">${escapeHtml(order.orderNumber)}</div>
          <div class="invoice-date">${escapeHtml(dateText)}</div>
          <span class="badge ${statusClass}">${escapeHtml(statusLabel)}</span>
        </div>
      </header>

      <section class="addresses">
        <div class="addr-card">
          <div class="addr-label">Bill to</div>
          <div class="addr-name">${escapeHtml(billingAddr?.firstName || order.customer?.firstName || '')} ${escapeHtml(billingAddr?.lastName || order.customer?.lastName || '')}</div>
          ${
            // Prefer the email collected at checkout (buyer's actual contact)
            // over the authenticated user's profile email — a logged-in admin
            // checking out for someone else would otherwise have their admin
            // email leak onto the customer's invoice.
            (() => {
              const email = billingAddr?.email || shippingAddr?.email || order.customer?.email;
              return email ? `<div class="addr-line">${escapeHtml(email)}</div>` : '';
            })()
          }
          ${billingAddr?.phone ? `<div class="addr-line">${escapeHtml(billingAddr.phone)}</div>` : ''}
        </div>
        ${
          shippingAddr
            ? `
        <div class="addr-card">
          <div class="addr-label">Ship to</div>
          <div class="addr-name">${escapeHtml(shippingAddr.firstName)} ${escapeHtml(shippingAddr.lastName)}</div>
          <div class="addr-line">${escapeHtml(shippingAddr.address1)}</div>
          ${shippingAddr.address2 ? `<div class="addr-line">${escapeHtml(shippingAddr.address2)}</div>` : ''}
          <div class="addr-line">${escapeHtml(shippingAddr.city)}${shippingAddr.state ? `, ${escapeHtml(shippingAddr.state)}` : ''}${shippingAddr.postalCode ? ` ${escapeHtml(shippingAddr.postalCode)}` : ''}</div>
          <div class="addr-line">${escapeHtml(shippingAddr.country)}</div>
        </div>`
            : ''
        }
      </section>

      ${
        payment
          ? // Render "Payment: <provider>" or "Payment: <provider> (<method>)"
            // — drop the parens entirely when provider === method to avoid
            // the "cod (cod)" duplicate that Cash-on-Delivery used to show.
            (() => {
              const provider = (payment.provider || '').trim();
              const method = (payment.method || '').trim();
              const showMethod = method && method.toLowerCase() !== provider.toLowerCase();
              const label = showMethod
                ? `${escapeHtml(provider)} (${escapeHtml(method)})`
                : escapeHtml(provider) || 'N/A';
              return `
      <div class="payment-row">
        <strong>Payment:</strong>
        ${label}
        ${payment.transactionId ? ` &middot; ${escapeHtml(payment.transactionId)}` : ''}
      </div>`;
            })()
          : ''
      }

      <section class="items-wrap">
        <table>
          <thead>
            <tr>
              <th class="col-num">#</th>
              <th class="col-item">Item</th>
              <th class="col-qty">Qty</th>
              <th class="col-price">Unit Price</th>
              <th class="col-total">Total</th>
            </tr>
          </thead>
          <tbody>
            ${itemsHtml}
          </tbody>
        </table>
      </section>

      <section class="totals-wrap">
        <div class="totals">
          <div class="row"><span class="label">Subtotal</span><span class="val">${formatPrice(order.subtotal)}</span></div>
          ${
            order.discount > 0
              ? `<div class="row discount"><span class="label">Discount${order.couponCode ? ` (${escapeHtml(order.couponCode)})` : ''}</span><span class="val">−${formatPrice(order.discount)}</span></div>`
              : ''
          }
          ${
            order.tax > 0
              ? `<div class="row"><span class="label">Tax</span><span class="val">${formatPrice(order.tax)}</span></div>`
              : ''
          }
          <div class="row"><span class="label">Shipping</span><span class="val">${order.shipping === 0 ? 'Free' : formatPrice(order.shipping)}</span></div>
          <div class="row grand"><span class="label">Total</span><span class="val">${formatPrice(order.total)}</span></div>
        </div>
      </section>

      ${
        order.notes
          ? `
      <section class="notes">
        <div class="label">Order notes</div>
        <div class="body">${escapeHtml(order.notes)}</div>
      </section>`
          : ''
      }

      <footer class="footer">
        <div class="footer-text">
          <div class="footer-thank">Thank you for shopping with ${escapeHtml(order.store.name)}.</div>
          <div>This invoice was generated automatically.</div>
        </div>
        ${
          order.store.email || order.store.phone || order.store.address
            ? `<div class="footer-contact">
                ${order.store.email ? `<div>${escapeHtml(order.store.email)}</div>` : ''}
                ${order.store.phone ? `<div>${escapeHtml(order.store.phone)}</div>` : ''}
                ${order.store.address ? `<div>${escapeHtml(order.store.address)}</div>` : ''}
              </div>`
            : ''
        }
      </footer>
    </div>
  </div>

  <div class="actions no-print">
    <button class="btn-print" type="button" onclick="window.print()">
      Print Invoice
    </button>
  </div>
</body>
</html>`;
  }
}
