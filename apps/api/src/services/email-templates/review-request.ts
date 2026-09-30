import { escapeHtml } from './_util';
import { EMAIL_THUMB_SIZE, emailImage } from './_layout';

export interface ReviewRequestData {
  to: string;
  customerName: string;
  items: Array<{
    productName: string;
    productNameAr?: string | null;
    productImage?: string | null;
    reviewLink: string;
  }>;
}

/**
 * Post-purchase review-request email.
 *
 * Receives all items in one call and renders a consolidated email:
 * - headline CTA for the first (or only) item
 * - secondary list for any additional items
 *
 * Consolidation is intentional — one email per order is less spammy for
 * buyers who ordered multiple products.
 */
export const reviewRequestTemplate = {
  subject: {
    en: (_d: ReviewRequestData, storeName: string) =>
      `How was your order from ${storeName}? Share a quick review`,
    ar: (_d: ReviewRequestData, storeName: string) =>
      `كيف كانت تجربتك مع طلبك من ${storeName}؟ شاركنا تقييمك`,
  },

  en: (d: ReviewRequestData, _storeName: string) => {
    const headline = d.items[0];
    const rest = d.items.slice(1);

    const headlineImg = headline.productImage
      ? `<p style="text-align:center;margin:16px 0;">
           ${emailImage({
             src: headline.productImage,
             alt: headline.productName,
             width: EMAIL_THUMB_SIZE + 16,
             height: EMAIL_THUMB_SIZE + 16,
             radius: 10,
             align: 'center',
           })}
         </p>`
      : '';

    const additionalItems =
      rest.length > 0
        ? `<h3 style="margin-top:28px;">Other items in this order</h3>
           <ul style="padding-inline-start:20px;">
             ${rest
               .map(
                 item =>
                   `<li style="margin:8px 0;">
                      <a href="${escapeHtml(item.reviewLink)}" style="color:var(--brand);">
                        Review ${escapeHtml(item.productName)}
                      </a>
                    </li>`
               )
               .join('')}
           </ul>`
        : '';

    return `
      <h2>How was it, ${escapeHtml(d.customerName)}?</h2>
      <p>Your order arrived about a week ago. Mind sharing a quick review?
         It helps other shoppers and helps us improve.</p>
      ${headlineImg}
      <p style="margin:24px 0;">
        <a href="${escapeHtml(headline.reviewLink)}" class="button">
          Review ${escapeHtml(headline.productName)}
        </a>
      </p>
      ${additionalItems}
      <p style="color:var(--ink-mute);font-size:12px;margin-top:28px;">
        Takes 30 seconds per item. Only verified buyers can review.
      </p>
    `;
  },

  ar: (d: ReviewRequestData, _storeName: string) => {
    const headline = d.items[0];
    const rest = d.items.slice(1);
    const headlineName = headline.productNameAr || headline.productName;

    const headlineImg = headline.productImage
      ? `<p style="text-align:center;margin:16px 0;">
           ${emailImage({
             src: headline.productImage,
             alt: headlineName,
             width: EMAIL_THUMB_SIZE + 16,
             height: EMAIL_THUMB_SIZE + 16,
             radius: 10,
             align: 'center',
           })}
         </p>`
      : '';

    const additionalItems =
      rest.length > 0
        ? `<h3 style="margin-top:28px;">باقي المنتجات</h3>
           <ul style="padding-inline-start:20px;">
             ${rest
               .map(item => {
                 const name = item.productNameAr || item.productName;
                 return `<li style="margin:8px 0;">
                           <a href="${escapeHtml(item.reviewLink)}" style="color:var(--brand);">
                             قيّم ${escapeHtml(name)}
                           </a>
                         </li>`;
               })
               .join('')}
           </ul>`
        : '';

    return `
      <h2>كيف كانت تجربتك يا ${escapeHtml(d.customerName)}؟</h2>
      <p>وصلك طلبك قبل أسبوع تقريباً. هل تشاركنا تقييمك القصير؟
         يساعد العملاء الآخرين ويساعدنا على التحسين.</p>
      ${headlineImg}
      <p style="margin:24px 0;">
        <a href="${escapeHtml(headline.reviewLink)}" class="button">
          قيّم ${escapeHtml(headlineName)}
        </a>
      </p>
      ${additionalItems}
      <p style="color:var(--ink-mute);font-size:12px;margin-top:28px;">
        يستغرق 30 ثانية لكل منتج. فقط المشترون الموثقون يمكنهم التقييم.
      </p>
    `;
  },
};
