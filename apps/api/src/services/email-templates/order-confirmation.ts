import { escapeHtml } from './_util';
import type { OrderEmailData } from '../email.service';

export const orderConfirmationTemplate = {
  subject: {
    en: (d: OrderEmailData, _storeName: string) => `Order Confirmed - #${d.orderNumber}`,
    ar: (d: OrderEmailData, _storeName: string) => `تم تأكيد الطلب - #${d.orderNumber}`,
  },

  en: (d: OrderEmailData, _storeName: string) => {
    const itemsHtml = d.items
      .map(
        item => `
      <tr>
        <td>${escapeHtml(item.name)}</td>
        <td style="text-align: center;">${item.quantity}</td>
        <td style="text-align: right;">${(item.price / 1000).toFixed(3)} KWD</td>
      </tr>`
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
      <tbody>${itemsHtml}</tbody>
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
  `;
  },

  ar: (d: OrderEmailData, _storeName: string) => {
    const itemsHtml = d.items
      .map(
        item => `
      <tr>
        <td>${escapeHtml(item.nameAr || item.name)}</td>
        <td style="text-align: center;">${item.quantity}</td>
        <td style="text-align: right;">${(item.price / 1000).toFixed(3)} د.ك</td>
      </tr>`
      )
      .join('');

    return `
    <h2>شكراً على طلبك!</h2>
    <p>مرحباً ${escapeHtml(d.customerName)}،</p>
    <p>استلمنا طلبك وجاري تجهيزه. سنبلغك حين يتم الشحن.</p>

    <h3>طلب رقم ${escapeHtml(d.orderNumber)}</h3>

    <table class="order-table">
      <thead>
        <tr>
          <th>الصنف</th>
          <th style="text-align: center;">الكمية</th>
          <th style="text-align: right;">السعر</th>
        </tr>
      </thead>
      <tbody>${itemsHtml}</tbody>
      <tfoot>
        <tr>
          <td colspan="2">المجموع الفرعي</td>
          <td style="text-align: right;">${(d.subtotal / 1000).toFixed(3)} د.ك</td>
        </tr>
        <tr>
          <td colspan="2">الضريبة</td>
          <td style="text-align: right;">${(d.tax / 1000).toFixed(3)} د.ك</td>
        </tr>
        <tr>
          <td colspan="2">الشحن</td>
          <td style="text-align: right;">${(d.shipping / 1000).toFixed(3)} د.ك</td>
        </tr>
        ${
          d.discount && d.discount > 0
            ? `<tr>
          <td colspan="2">الخصم${d.couponCode ? ` (${escapeHtml(d.couponCode)})` : ''}</td>
          <td style="text-align: right;">-${(d.discount / 1000).toFixed(3)} د.ك</td>
        </tr>`
            : ''
        }
        <tr class="total-row">
          <td colspan="2">الإجمالي</td>
          <td style="text-align: right;">${(d.total / 1000).toFixed(3)} د.ك</td>
        </tr>
      </tfoot>
    </table>

    <div class="address-box">
      <strong>عنوان الشحن</strong><br>
      ${escapeHtml(d.shippingAddress.firstName)} ${escapeHtml(d.shippingAddress.lastName)}<br>
      ${escapeHtml(d.shippingAddress.address1)}<br>
      ${d.shippingAddress.address2 ? escapeHtml(d.shippingAddress.address2) + '<br>' : ''}
      ${escapeHtml(d.shippingAddress.city)}, ${escapeHtml(d.shippingAddress.state)} ${escapeHtml(d.shippingAddress.postalCode)}<br>
      ${escapeHtml(d.shippingAddress.country)}
    </div>
  `;
  },
};
