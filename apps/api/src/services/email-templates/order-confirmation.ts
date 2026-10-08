import { orderAddressLines, orderTaxPlacement, taxInvoiceInfo } from '@force/shared';
import { escapeHtml, emailMoney } from './_util';
import { waMeEmailBlock } from './_wa-me';
import type { OrderEmailData } from '../email.service';

/** Delivery-address lines (street, landmark, area + governorate, country) with no empty/stray lines. */
function addressHtml(addr: OrderEmailData['shippingAddress'], locale: 'ar' | 'en'): string {
  return orderAddressLines(addr as unknown as Record<string, unknown>, locale)
    .map(escapeHtml)
    .join('<br>');
}

const LABELS = {
  en: {
    subtotal: 'Subtotal',
    coupon: 'Coupon',
    promotion: 'Promotion',
    loyaltyPoints: 'Loyalty points',
    discount: 'Discount',
    tax: 'Tax',
    shipping: 'Shipping',
    codFee: 'Cash on delivery fee',
    total: 'Total',
    taxIncluded: 'Incl. VAT',
    vat: (rate: number | null) => (rate === null ? 'VAT' : `VAT (${rate}%)`),
    vatIncluded: (rate: number | null) => (rate === null ? 'Incl. VAT' : `Incl. VAT (${rate}%)`),
    sellerTrn: 'Seller tax registration no.',
  },
  ar: {
    subtotal: 'المجموع الفرعي',
    coupon: 'كوبون',
    promotion: 'عرض ترويجي',
    loyaltyPoints: 'نقاط الولاء',
    discount: 'الخصم',
    tax: 'الضريبة',
    shipping: 'الشحن',
    codFee: 'رسوم الدفع عند الاستلام',
    total: 'الإجمالي',
    taxIncluded: 'شامل ضريبة القيمة المضافة',
    vat: (rate: number | null) =>
      rate === null ? 'ضريبة القيمة المضافة' : `ضريبة القيمة المضافة (${rate}%)`,
    vatIncluded: (rate: number | null) =>
      rate === null ? 'شامل ضريبة القيمة المضافة' : `شامل ضريبة القيمة المضافة (${rate}%)`,
    sellerTrn: 'رقم التسجيل الضريبي للبائع',
  },
} as const;

/**
 * The totals block, shared by both locales so they cannot drift.
 *
 *  - Tax placement is the shared `orderTaxPlacement` (issue 2210): exclusive
 *    tax is a summed row — only when there IS tax (issue 2168); INCLUSIVE tax
 *    is already inside `total`, so it is a caption after Total.
 *  - Issue 2239: the discount is split into coupon / promotion / loyalty
 *    points / remainder like the invoice and every order screen, so redeemed
 *    points are never attributed to the coupon.
 */
function totalsRows(d: OrderEmailData, locale: 'en' | 'ar'): string {
  const L = LABELS[locale];
  const money = (v: number) => emailMoney(v, d.currency, locale);
  const row = (label: string, value: string, cls = '') =>
    `<tr${cls ? ` class="${cls}"` : ''}>
          <td colspan="2">${label}</td>
          <td style="text-align: end;">${value}</td>
        </tr>`;
  const promotionName = locale === 'ar' ? d.promotionNameAr || d.promotionName : d.promotionName;
  const coupon = d.couponDiscount ?? 0;
  const promotion = d.promotionDiscount ?? 0;
  const loyalty = d.loyaltyDiscount ?? 0;
  const other = Math.max(0, (d.discount ?? 0) - coupon - promotion - loyalty);
  // A payload without the lever split (an older producer) keeps the previous
  // single annotated line: coupon code first, else the promotion name.
  const hasLevers =
    d.couponDiscount !== undefined ||
    d.promotionDiscount !== undefined ||
    d.loyaltyDiscount !== undefined;
  const legacyLabel = hasLevers ? null : d.couponCode ? d.couponCode : promotionName;
  const legacyAnnotation = legacyLabel ? ` (${escapeHtml(legacyLabel)})` : '';
  const { taxRow, includedTaxCaption } = orderTaxPlacement(d);
  // VAT wording + seller TRN only for an order priced under a VERIFIED tax
  // profile (ruling TAX-2); otherwise the historic neutral labels.
  const taxInfo = taxInvoiceInfo({ ...d, discount: d.discount ?? 0 });
  return [
    row(L.subtotal, money(d.subtotal)),
    coupon > 0
      ? row(
          `${L.coupon}${d.couponCode ? ` (${escapeHtml(d.couponCode)})` : ''}`,
          `-${money(coupon)}`
        )
      : '',
    promotion > 0
      ? row(
          `${L.promotion}${promotionName ? ` (${escapeHtml(promotionName)})` : ''}`,
          `-${money(promotion)}`
        )
      : '',
    loyalty > 0
      ? row(
          `${L.loyaltyPoints}${d.loyaltyPointsRedeemed ? ` (${d.loyaltyPointsRedeemed})` : ''}`,
          `-${money(loyalty)}`
        )
      : '',
    other > 0 ? row(`${L.discount}${legacyAnnotation}`, `-${money(other)}`) : '',
    // subtotal → discounts → shipping → COD fee → VAT → total (ruling MONEYB-2)
    row(L.shipping, money(d.shipping)),
    (d.codFee ?? 0) > 0 ? row(L.codFee, money(d.codFee ?? 0)) : '',
    taxRow !== null && (taxRow > 0 || taxInfo)
      ? row(taxInfo ? L.vat(taxInfo.ratePercent) : L.tax, money(taxRow))
      : '',
    row(L.total, money(d.total), 'total-row'),
    includedTaxCaption !== null
      ? `<tr class="tax-included">
          <td colspan="3" style="text-align: end; color: #6b7280; font-size: 12px;">${taxInfo ? L.vatIncluded(taxInfo.ratePercent) : L.taxIncluded} ${money(includedTaxCaption)}</td>
        </tr>`
      : '',
    taxInfo
      ? `<tr class="seller-trn">
          <td colspan="3" style="text-align: end; color: #6b7280; font-size: 12px;">${L.sellerTrn}: <span dir="ltr">${escapeHtml(taxInfo.sellerTaxRegistrationNumber)}</span></td>
        </tr>`
      : '',
  ]
    .filter(Boolean)
    .join('\n        ');
}

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
        <td style="text-align: end;">${emailMoney(item.price, d.currency, 'en')}</td>
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
          <th style="text-align: end;">Price</th>
        </tr>
      </thead>
      <tbody>${itemsHtml}</tbody>
      <tfoot>
        ${totalsRows(d, 'en')}
      </tfoot>
    </table>

    <div class="address-box">
      <strong>Shipping Address</strong><br>
      ${escapeHtml(d.shippingAddress.firstName)} ${escapeHtml(d.shippingAddress.lastName)}<br>
      ${addressHtml(d.shippingAddress, 'en')}
    </div>
    ${waMeEmailBlock(d.waMe, 'en')}
  `;
  },

  ar: (d: OrderEmailData, _storeName: string) => {
    const itemsHtml = d.items
      .map(
        item => `
      <tr>
        <td>${escapeHtml(item.nameAr || item.name)}</td>
        <td style="text-align: center;">${item.quantity}</td>
        <td style="text-align: end;">${emailMoney(item.price, d.currency, 'ar')}</td>
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
          <th style="text-align: end;">السعر</th>
        </tr>
      </thead>
      <tbody>${itemsHtml}</tbody>
      <tfoot>
        ${totalsRows(d, 'ar')}
      </tfoot>
    </table>

    <div class="address-box">
      <strong>عنوان الشحن</strong><br>
      ${escapeHtml(d.shippingAddress.firstName)} ${escapeHtml(d.shippingAddress.lastName)}<br>
      ${addressHtml(d.shippingAddress, 'ar')}
    </div>
    ${waMeEmailBlock(d.waMe, 'ar')}
  `;
  },
};
