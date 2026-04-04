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

export class InvoiceService {
  /**
   * Generate HTML invoice for an order
   */
  static async generateInvoice(storeId: string, orderId: string): Promise<string> {
    const order = await prisma.order.findFirst({
      where: { id: orderId, storeId },
      include: {
        store: { select: { name: true, email: true, phone: true, address: true, logo: true } },
        customer: { select: { email: true, firstName: true, lastName: true } },
        items: { include: { product: { include: { images: { take: 1 } } } } },
        payments: { where: { status: 'completed' }, take: 1 },
      },
    });

    if (!order) {
      throw new AppError(404, 'NOT_FOUND', 'Order not found');
    }

    const formatPrice = (fils: number) => `${(fils / 1000).toFixed(3)} KWD`;
    const shippingAddr = order.shippingAddress as Record<string, string> | null;
    const payment = order.payments?.[0];

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Invoice #${escapeHtml(order.orderNumber)}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Helvetica Neue', Arial, sans-serif; color: #1a1a1a; padding: 40px; max-width: 800px; margin: 0 auto; }
    .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 40px; border-bottom: 2px solid #ff6e00; padding-bottom: 20px; }
    .store-name { font-size: 24px; font-weight: 700; color: #ff6e00; }
    .store-contact { font-size: 12px; color: #666; margin-top: 4px; }
    .invoice-title { text-align: right; }
    .invoice-title h1 { font-size: 28px; color: #333; }
    .invoice-title .meta { font-size: 12px; color: #666; margin-top: 4px; }
    .addresses { display: flex; gap: 40px; margin-bottom: 30px; }
    .address-block { flex: 1; }
    .address-block h3 { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #999; margin-bottom: 8px; }
    .address-block p { font-size: 13px; line-height: 1.5; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 30px; }
    thead th { background: #f8f8f8; padding: 10px 12px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: #666; border-bottom: 1px solid #e0e0e0; text-align: left; }
    thead th:last-child, thead th:nth-child(3), thead th:nth-child(4) { text-align: right; }
    tbody td { padding: 12px; font-size: 13px; border-bottom: 1px solid #f0f0f0; }
    tbody td:last-child, tbody td:nth-child(3), tbody td:nth-child(4) { text-align: right; }
    .totals { margin-left: auto; width: 260px; }
    .totals .row { display: flex; justify-content: space-between; padding: 6px 0; font-size: 13px; }
    .totals .row.total { border-top: 2px solid #333; padding-top: 10px; margin-top: 6px; font-size: 16px; font-weight: 700; }
    .footer { margin-top: 40px; padding-top: 20px; border-top: 1px solid #e0e0e0; font-size: 11px; color: #999; text-align: center; }
    .payment-info { background: #f8faf8; border: 1px solid #e0e8e0; border-radius: 6px; padding: 12px 16px; margin-bottom: 20px; font-size: 12px; }
    .status-badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }
    .status-paid { background: #dcfce7; color: #166534; }
    .status-pending { background: #fef9c3; color: #854d0e; }
    @media print { body { padding: 20px; } .no-print { display: none; } }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <div class="store-name">${escapeHtml(order.store.name)}</div>
      ${order.store.email ? `<div class="store-contact">${escapeHtml(order.store.email)}</div>` : ''}
      ${order.store.phone ? `<div class="store-contact">${escapeHtml(order.store.phone)}</div>` : ''}
      ${order.store.address ? `<div class="store-contact">${escapeHtml(order.store.address)}</div>` : ''}
    </div>
    <div class="invoice-title">
      <h1>INVOICE</h1>
      <div class="meta">
        <div><strong>Invoice #:</strong> ${escapeHtml(order.orderNumber)}</div>
        <div><strong>Date:</strong> ${escapeHtml(new Date(order.createdAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }))}</div>
        <div><strong>Status:</strong> <span class="status-badge ${order.paymentStatus === 'paid' ? 'status-paid' : 'status-pending'}">${escapeHtml(order.paymentStatus.toUpperCase())}</span></div>
      </div>
    </div>
  </div>

  <div class="addresses">
    <div class="address-block">
      <h3>Bill To</h3>
      <p><strong>${escapeHtml(order.customer?.firstName || '')} ${escapeHtml(order.customer?.lastName || '')}</strong></p>
      <p>${escapeHtml(order.customer?.email || '')}</p>
    </div>
    ${
      shippingAddr
        ? `
    <div class="address-block">
      <h3>Ship To</h3>
      <p><strong>${escapeHtml(shippingAddr.firstName)} ${escapeHtml(shippingAddr.lastName)}</strong></p>
      <p>${escapeHtml(shippingAddr.address1)}</p>
      ${shippingAddr.address2 ? `<p>${escapeHtml(shippingAddr.address2)}</p>` : ''}
      <p>${escapeHtml(shippingAddr.city)}, ${escapeHtml(shippingAddr.state)} ${escapeHtml(shippingAddr.postalCode)}</p>
      <p>${escapeHtml(shippingAddr.country)}</p>
    </div>`
        : ''
    }
  </div>

  ${
    payment
      ? `
  <div class="payment-info">
    <strong>Payment:</strong> ${payment.method ? `${escapeHtml(payment.provider)} (${escapeHtml(payment.method)})` : escapeHtml(payment.provider) || 'N/A'} &mdash;
    Transaction: ${escapeHtml(payment.transactionId) || 'N/A'}
  </div>`
      : ''
  }

  <table>
    <thead>
      <tr>
        <th>#</th>
        <th>Item</th>
        <th>Qty</th>
        <th>Unit Price</th>
        <th>Total</th>
      </tr>
    </thead>
    <tbody>
      ${order.items
        .map(
          (item, i) => `
      <tr>
        <td>${i + 1}</td>
        <td>${escapeHtml(item.productName)}${item.sku ? ` <span style="color:#999">(${escapeHtml(item.sku)})</span>` : ''}</td>
        <td style="text-align:right">${item.quantity}</td>
        <td style="text-align:right">${formatPrice(item.price)}</td>
        <td style="text-align:right">${formatPrice(item.total)}</td>
      </tr>`
        )
        .join('')}
    </tbody>
  </table>

  <div class="totals">
    <div class="row"><span>Subtotal</span><span>${formatPrice(order.subtotal)}</span></div>
    <div class="row"><span>Tax</span><span>${formatPrice(order.tax)}</span></div>
    <div class="row"><span>Shipping</span><span>${order.shipping === 0 ? 'Free' : formatPrice(order.shipping)}</span></div>
    <div class="row total"><span>Total</span><span>${formatPrice(order.total)}</span></div>
  </div>

  <div class="footer">
    <p>Thank you for shopping with ${escapeHtml(order.store.name)}</p>
    <p style="margin-top:4px">This invoice was generated automatically</p>
  </div>

  <div class="no-print" style="text-align:center;margin-top:30px">
    <button onclick="window.print()" style="background:#ff6e00;color:#fff;border:none;padding:10px 24px;border-radius:6px;cursor:pointer;font-size:14px;">Print Invoice</button>
  </div>
</body>
</html>`;
  }
}
