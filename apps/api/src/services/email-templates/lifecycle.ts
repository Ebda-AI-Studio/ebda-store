import type { LifecycleEmailKind } from '@ebda/shared';
import { escapeHtml } from './_util';

/**
 * The self-serve lifecycle emails (growth strategy 3.4): setup nudges, trial recap, first-order referral
 * ask. Sent from the platform sender in the Ebda shell (night / gold, never orange). Arabic is Egyptian
 * and addresses no one by gender (imperative plural-neutral phrasing), because the owner's gender is
 * not known. One call to action each. Every email ends with the unsubscribe line; the sending code
 * refuses to send without a link, so the line cannot be dropped by a template edit.
 */
export interface LifecycleEmailData {
  kind: LifecycleEmailKind;
  storeName: string;
  /** Admin deep links resolved by the caller, one per destination. */
  links: {
    products: string;
    payment: string;
    storefront: string;
    billing: string;
  };
  unsubscribeUrl: string;
  /** trial_recap: carts the abandoned-cart recovery brought back during the trial. */
  recoveredCarts?: number;
  /** trial_recap: whole days left in the trial. */
  daysLeft?: number;
  /** first_order: Ebda link carrying the referral UTMs. */
  referralUrl?: string;
  /** Owner-only "send test to myself": the subject says so, so it is never mistaken for the real one. */
  isTest?: boolean;
}

type Lang = 'en' | 'ar';

interface Copy {
  subject: string;
  heading: string;
  body: string[];
  cta: string;
  href: string;
}

const waShare = (text: string) => `https://wa.me/?text=${encodeURIComponent(text)}`;

function copyFor(d: LifecycleEmailData, lang: Lang): Copy {
  const ar = lang === 'ar';
  const name = d.storeName;
  switch (d.kind) {
    case 'add_products':
      return ar
        ? {
            subject: 'أول 3 منتجات في 5 دقايق',
            heading: `متجر ${name} لسه فاضي`,
            body: [
              'المتجر جاهز بس مفيهوش منتجات. ضيف أول 3 منتجات (صورة وسعر وخلاص) وهتلاقي اللينك جاهز تبعته للعملاء.',
              'عندك ملف إكسيل أو كتالوج جاهز؟ استورده كله مرة واحدة والوصف وكلمات البحث بيتعملوا بالذكاء الاصطناعي.',
            ],
            cta: 'أضف المنتجات',
            href: d.links.products,
          }
        : {
            subject: 'Add your first 3 products in 5 minutes',
            heading: `${name} has no products yet`,
            body: [
              'Your store is ready but empty. Add your first 3 products (a photo and a price is enough) and your link is ready to send to customers.',
              'Have a spreadsheet or a catalogue? Import it in one go: descriptions and search words are written for you.',
            ],
            cta: 'Add products',
            href: d.links.products,
          };
    case 'payment_shipping':
      return ar
        ? {
            subject: 'الكاش والشحن جاهزين؟',
            heading: 'فاضل خطوة قبل أول طلب',
            body: [
              'عشان العميل يكمّل الطلب لازم الدفع والشحن يكونوا متظبطين: الدفع عند الاستلام أو إنستا باي، ومناطق الشحن وأسعارها.',
              'خد 3 دقايق وراجعهم دلوقتي.',
            ],
            cta: 'راجع الدفع والشحن',
            href: d.links.payment,
          }
        : {
            subject: 'Are cash and shipping ready?',
            heading: 'One step left before your first order',
            body: [
              'For a customer to finish an order, payment and shipping need to be set: cash on delivery or InstaPay, and your shipping areas with their prices.',
              'Take 3 minutes and check them now.',
            ],
            cta: 'Check payment and shipping',
            href: d.links.payment,
          };
    case 'test_order':
      return ar
        ? {
            subject: 'اطلب من متجرك كأنك عميل',
            heading: 'جرّب الطلب بنفسك',
            body: [
              'افتح متجرك على الموبايل واعمل طلب كأنك عميل: اختار منتج، ضيفه للسلة، وكمّل لحد الشحن والدفع.',
              'كده تشوف اللي العميل بيشوفه، وتصلّح أي حاجة قبل ما حد يطلب فعلًا.',
            ],
            cta: 'افتح المتجر',
            href: d.links.storefront,
          }
        : {
            subject: 'Order from your store like a customer',
            heading: 'Try an order yourself',
            body: [
              'Open your store on your phone and place an order like a customer: pick a product, add it to the cart and go through shipping and payment.',
              'You will see what your customers see, and can fix anything before a real order arrives.',
            ],
            cta: 'Open your store',
            href: d.links.storefront,
          };
    case 'share_link':
      return ar
        ? {
            subject: 'حط اللينك في البايو',
            heading: 'متجرك محتاج يتشاف',
            body: [
              'اللينك ده هو متجرك. حطه في البايو على إنستجرام، وابعته على واتساب لأي عميل بيسأل "بكام؟".',
              `<a href="${escapeHtml(d.links.storefront)}">${escapeHtml(d.links.storefront)}</a>`,
            ],
            cta: 'افتح اللينك وانسخه',
            href: d.links.storefront,
          }
        : {
            subject: 'Put your link in your bio',
            heading: 'Your store needs to be seen',
            body: [
              'This link is your store. Put it in your Instagram bio and send it on WhatsApp to anyone who asks "how much?".',
              `<a href="${escapeHtml(d.links.storefront)}">${escapeHtml(d.links.storefront)}</a>`,
            ],
            cta: 'Open the link and copy it',
            href: d.links.storefront,
          };
    case 'trial_recap': {
      const n = d.recoveredCarts ?? 0;
      const days = d.daysLeft ?? 0;
      return ar
        ? {
            subject: `فاضل ${days} أيام على نهاية التجربة`,
            heading: n > 0 ? `رجّعنالك ${n} سلة` : 'شوف التجربة عملت إيه',
            body: [
              n > 0
                ? `خلال التجربة، استرجاع السلات المتروكة رجّع ${n} سلة لمتجرك. بعد ${days} أيام التجربة بتخلص، واختار الباقة اللي تكمّل بيها.`
                : `التجربة بتخلص بعد ${days} أيام. لسه مفيش سلات مسترجعة، وده طبيعي لو الطلبات لسه قليلة. شوف الباقات واختار اللي يناسبك.`,
              'لو مختارتش باقة، المتجر بيفضل شغال على الباقة المجانية بحدودها.',
            ],
            cta: 'اختار الباقة',
            href: d.links.billing,
          }
        : {
            subject: `${days} days left in your trial`,
            heading: n > 0 ? `We brought back ${n} carts` : 'See what the trial did',
            body: [
              n > 0
                ? `During the trial, abandoned-cart recovery brought ${n} carts back to your store. The trial ends in ${days} days: choose the plan you continue on.`
                : `The trial ends in ${days} days. No carts have been recovered yet, which is normal while orders are few. Look at the plans and choose what fits.`,
              'If you do not choose a plan, your store keeps running on the free plan with its limits.',
            ],
            cta: 'Choose a plan',
            href: d.links.billing,
          };
    }
    case 'first_order': {
      const link = d.referralUrl ?? '';
      const msg = ar
        ? `جربت ابدأ ستور لمتجري وشغال كويس: ${link}`
        : `I run my store on Ebda Store and it works well: ${link}`;
      return ar
        ? {
            subject: 'أول طلب وصل!',
            heading: 'مبروك على أول طلب',
            body: [
              `أول طلب في ${name} وصل. من هنا وبعدين المتجر بياخد الطلبات لوحده.`,
              'عندك صاحب أو زميل بيبيع أونلاين؟ ابعتله ابدأ ستور.',
            ],
            cta: 'ابعت على واتساب',
            href: waShare(msg),
          }
        : {
            subject: 'Your first order is in!',
            heading: 'Congratulations on your first order',
            body: [
              `The first order in ${name} has arrived. From here your store takes orders by itself.`,
              'Know a friend or colleague who sells online? Send them Ebda Store.',
            ],
            cta: 'Share on WhatsApp',
            href: waShare(msg),
          };
    }
  }
}

export function lifecycleSubject(d: LifecycleEmailData, lang: Lang): string {
  const subject = copyFor(d, lang).subject;
  return d.isTest ? `${lang === 'ar' ? '[تجربة]' : '[Test]'} ${subject}` : subject;
}

export function lifecycleContent(d: LifecycleEmailData, lang: Lang): string {
  const c = copyFor(d, lang);
  const ar = lang === 'ar';
  const unsub = ar
    ? `بتوصلك الرسالة دي لأنك فتحت متجر على ابدأ ستور. <a href="${escapeHtml(d.unsubscribeUrl)}">إلغاء الاشتراك في رسائل البداية</a>`
    : `You get this because you opened a store on Ebda Store. <a href="${escapeHtml(d.unsubscribeUrl)}">Unsubscribe from setup emails</a>`;
  return `
    <h2>${escapeHtml(c.heading)}</h2>
    ${c.body.map(p => `<p>${p.startsWith('<a ') ? p : escapeHtml(p)}</p>`).join('\n    ')}
    <p style="text-align: center; margin: 24px 0;">
      <a href="${escapeHtml(c.href)}" class="button">${escapeHtml(c.cta)}</a>
    </p>
    <p style="font-size:12px;color:#94a3b8;">${unsub}</p>
  `;
}

export const lifecycleTemplate = { subject: lifecycleSubject, content: lifecycleContent };
