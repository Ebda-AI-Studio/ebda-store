'use client';

import { SectionHeader } from '@/components/landing/SectionHeader';
import { Aurora } from '@/components/landing/Reveal';
import { cn } from '@/lib/utils';
import { useLanguage } from '@/contexts/LanguageContext';

interface Merchant {
  name: string;
  logo: string;
  quoteEn: string;
  quoteAr: string;
  url: string;
}

const MERCHANTS: Merchant[] = [
  {
    name: 'Wady Aljuz',
    logo: 'https://pub-ff2bd6a1f8dd4567b9dd4c92e7a8b0f7.r2.dev/stores/dfc1c208-1c30-4eba-9821-6f3be15e3506/branding/f50c74cd-fc75-4d40-af6d-7003adef8db1.svg',
    quoteEn: 'From our shelves to checkout in a day — the platform runs the whole store.',
    quoteAr: 'من الرف إلى الدفع في يوم واحد — المنصة تدير المتجر بالكامل.',
    url: 'https://wadyaljuz.com',
  },
  {
    name: 'Pecannbee',
    logo: 'https://pub-ff2bd6a1f8dd4567b9dd4c92e7a8b0f7.r2.dev/stores/359afc1f-ea5b-4f8d-b372-c038c6c057f7/logos/922a161f-6a7b-41b7-b597-81ec7e9e7486-4175480730368983c07345ad2_37965252.png',
    quoteEn: 'The AI writes our product pages in Arabic and English. We just sell.',
    quoteAr: 'الذكاء الاصطناعي يكتب صفحات منتجاتنا بالعربي والإنجليزي. نحن نبيع فقط.',
    url: 'https://store.forcemediakw.com/pecannbee',
  },
  {
    name: 'Palora',
    logo: 'https://pub-ff2bd6a1f8dd4567b9dd4c92e7a8b0f7.r2.dev/branding/98ef3992-fb82-4164-8cf8-8e9f15780e4c.png',
    quoteEn: 'Payments, delivery and books all in one place. Setup took an afternoon.',
    quoteAr: 'الدفع والتوصيل والطلبات في مكان واحد. الإعداد استغرق بعد الظهر فقط.',
    url: 'https://store.forcemediakw.com/palora',
  },
];

export function MerchantsSection() {
  const { t } = useLanguage();

  return (
    <section id="merchants" className="relative overflow-hidden bg-black py-20 md:py-28">
      <Aurora />
      <div className="relative z-10 mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <SectionHeader
          kicker={t('REAL KUWAITI STORES', 'متاجر كويتية حقيقية')}
          title={t('Built on Force AI', 'مبنية على Force AI')}
          subtitle={t(
            'Live Kuwaiti stores already selling every day — from groceries to gifts.',
            'متاجر كويتية حقيقية تبيع كل يوم — من البقالة إلى الهدايا.'
          )}
          className="mb-16"
        />

        <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
          {MERCHANTS.map(merchant => (
            <div
              key={merchant.name}
              className={cn(
                'rounded-2xl border border-white/10 bg-white/[0.04] p-8 backdrop-blur',
                'transition-all hover:-translate-y-1 hover:border-primary/40',
                'hover:shadow-[0_8px_40px_rgba(255,110,1,0.15)]'
              )}
            >
              {/* Logo chip */}
              <div className="mb-6 flex justify-center">
                <div className="rounded-xl bg-white/95 p-3">
                  <img
                    src={merchant.logo}
                    alt={merchant.name}
                    className="h-16 w-auto object-contain"
                    loading="lazy"
                    decoding="async"
                  />
                </div>
              </div>

              {/* Store name */}
              <h3 className="mb-2 text-center text-lg font-semibold text-white">{merchant.name}</h3>

              {/* Quote */}
              <p className="mb-6 text-center text-sm italic leading-relaxed text-white/85">
                &ldquo;{t(merchant.quoteEn, merchant.quoteAr)}&rdquo;
              </p>

              {/* Visit link */}
              <div className="flex justify-center">
                <a
                  href={merchant.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-primary hover:underline"
                >
                  {t('Visit store', 'زيارة المتجر')} &rarr;
                </a>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
