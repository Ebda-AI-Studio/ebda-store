import { buildCodConfirmationMessage } from '@ebda/shared/wa-me-messages';
import { DEMO_STORES } from '../lib/demo-stores';
import type { Locale } from '../lib/site';
import { Phone } from './Devices';

const CAPTION: Record<Locale, string> = {
  ar: 'الرسالة الجاهزة اللي العميل بيبعتها بضغطة واحدة بعد طلب الدفع عند الاستلام.',
  en: 'The ready-made message a customer sends with one tap after a cash-on-delivery order.',
};

/**
 * The /whatsapp hero visual (Ruling MKT-IMPECCABLE-3). It shows the REAL prefilled message the product builds
 * (`buildCodConfirmationMessage`, the same function the order page and emails call) over the demo store's own
 * products and prices, in the site's phone frame. No product UI is drawn: the only chrome is a chat bubble, and the
 * text is real 13px+ copy (not a scaled-down screenshot).
 */
export function WaChatVisual({ locale }: { locale: Locale }) {
  const store = DEMO_STORES.dahab;
  const bands = store.products[1];
  const chain = store.products[3];
  const message = buildCodConfirmationMessage({
    locale,
    orderNumber: '1042',
    storeName: store.name[locale],
    items: [
      { name: bands.name.en, nameAr: bands.name.ar, quantity: 1 },
      { name: chain.name.en, nameAr: chain.name.ar, quantity: 1 },
    ],
    totalMinor: (bands.price + chain.price) * 100,
    address: { area: 'Maadi', areaAr: 'المعادي', governorate: 'Cairo', governorateAr: 'القاهرة' },
  });
  return (
    <figure className="wa-visual">
      <Phone className="wa-phone">
        <div className="wa-chat">
          <p className="wa-chat-head">{store.name[locale]}</p>
          <div className="wa-chat-body">
            <p className="wa-bubble" dir={locale === 'ar' ? 'rtl' : 'ltr'}>
              {message}
            </p>
          </div>
        </div>
      </Phone>
      <figcaption className="muted small">{CAPTION[locale]}</figcaption>
    </figure>
  );
}
