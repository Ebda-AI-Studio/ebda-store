'use client';

import Link from 'next/link';
import { ShopChrome } from '../../components';
import { useStore, useStoreUrl } from '../../contexts/StoreContext';
import { useLanguage, translations } from '../../contexts/LanguageContext';

export default function AboutClient() {
  const { store } = useStore();
  const storeUrl = useStoreUrl();
  const { t, language } = useLanguage();

  // Tenant brand string — pick the localized store name so the heading and
  // welcome line read in the active language. Fallback to whichever name
  // exists when only one localization was filled in.
  const isRtl = language === 'ar';
  const brandName =
    (isRtl ? store.nameAr : store.name) || store.name || store.nameAr || t('our store', 'متجرنا');

  const headingText = brandName || t('Our Store', 'متجرنا');
  const descriptionText =
    (isRtl ? store.descriptionAr : store.description) ||
    store.description ||
    t(
      `Welcome to ${brandName}! We are passionate about providing high-quality products and exceptional customer service.`,
      `مرحباً بكم في ${brandName}! نحن شغوفون بتقديم منتجات عالية الجودة وخدمة عملاء استثنائية.`
    );

  return (
    <ShopChrome>
      <div className="container mx-auto px-4 py-8">
        <div className="max-w-4xl mx-auto">
          <h1 className="text-4xl font-bold mb-8">{headingText}</h1>

          <div className="prose prose-lg max-w-none">
            <section className="mb-12">
              <h2 className="text-2xl font-semibold mb-4">{t('Our Story', 'قصتنا')}</h2>
              <p className="text-muted-foreground mb-4">{descriptionText}</p>
              <p className="text-muted-foreground">
                {t(
                  'Today, we continue to grow and evolve, always keeping our customers at the heart of everything we do.',
                  'اليوم، نواصل النمو والتطور، مع إبقاء عملائنا في صميم كل ما نقوم به.'
                )}
              </p>
            </section>

            <section className="mb-12">
              <h2 className="text-2xl font-semibold mb-4">{t('Our Mission', 'مهمتنا')}</h2>
              <p className="text-muted-foreground">
                {t(
                  'We strive to deliver the best products at competitive prices while maintaining the highest standards of customer service. Our team works tirelessly to ensure every customer has a seamless shopping experience.',
                  'نسعى لتقديم أفضل المنتجات بأسعار تنافسية مع الحفاظ على أعلى معايير خدمة العملاء. يعمل فريقنا بلا كلل لضمان تجربة تسوق سلسة لكل عميل.'
                )}
              </p>
            </section>

            <section className="mb-12">
              <h2 className="text-2xl font-semibold mb-4">
                {t('Why Choose Us?', 'لماذا تختارنا؟')}
              </h2>
              <div className="grid md:grid-cols-3 gap-6 mt-6">
                <div className="bg-muted p-6 rounded-lg">
                  <div className="w-12 h-12 bg-primary/10 rounded-full flex items-center justify-center mb-4">
                    <svg
                      className="w-6 h-6 text-primary"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M5 13l4 4L19 7"
                      />
                    </svg>
                  </div>
                  <h3 className="font-semibold mb-2">
                    {t('Quality Products', 'منتجات عالية الجودة')}
                  </h3>
                  <p className="text-muted-foreground text-sm">
                    {t(
                      'We carefully curate our selection to ensure only the best products reach you.',
                      'نختار منتجاتنا بعناية لضمان وصول الأفضل إليك.'
                    )}
                  </p>
                </div>
                <div className="bg-muted p-6 rounded-lg">
                  <div className="w-12 h-12 bg-[hsl(var(--success))]/20 rounded-full flex items-center justify-center mb-4">
                    <svg
                      className="w-6 h-6 text-[hsl(var(--success))]"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                      />
                    </svg>
                  </div>
                  <h3 className="font-semibold mb-2">{t('Great Prices', 'أسعار رائعة')}</h3>
                  <p className="text-muted-foreground text-sm">
                    {t(
                      'Competitive pricing without compromising on quality or service.',
                      'أسعار تنافسية دون المساومة على الجودة أو الخدمة.'
                    )}
                  </p>
                </div>
                <div className="bg-muted p-6 rounded-lg">
                  <div className="w-12 h-12 bg-primary/10 rounded-full flex items-center justify-center mb-4">
                    <svg
                      className="w-6 h-6 text-primary"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M18.364 5.636l-3.536 3.536m0 5.656l3.536 3.536M9.172 9.172L5.636 5.636m3.536 9.192l-3.536 3.536M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-5 0a4 4 0 11-8 0 4 4 0 018 0z"
                      />
                    </svg>
                  </div>
                  <h3 className="font-semibold mb-2">{t('24/7 Support', 'دعم على مدار الساعة')}</h3>
                  <p className="text-muted-foreground text-sm">
                    {t(
                      'Our customer support team is always here to help you.',
                      'فريق دعم العملاء لدينا موجود دائماً لمساعدتك.'
                    )}
                  </p>
                </div>
              </div>
            </section>

            {/* Show store contact details if available */}
            {(store.email || store.phone || store.address) && (
              <section className="mb-12">
                <h2 className="text-2xl font-semibold mb-4">{t('Get In Touch', 'تواصل معنا')}</h2>
                <ul className="space-y-2 text-muted-foreground">
                  {store.email && (
                    <li>
                      <span className="font-medium">{t('Email:', 'البريد الإلكتروني:')}</span>{' '}
                      <a href={`mailto:${store.email}`} className="text-primary hover:underline">
                        {store.email}
                      </a>
                    </li>
                  )}
                  {store.phone && (
                    <li>
                      <span className="font-medium">{t('Phone:', 'الهاتف:')}</span>{' '}
                      <a href={`tel:${store.phone}`} className="text-primary hover:underline">
                        {store.phone}
                      </a>
                    </li>
                  )}
                  {store.address && (
                    <li>
                      <span className="font-medium">{t('Address:', 'العنوان:')}</span>{' '}
                      {store.address}
                    </li>
                  )}
                </ul>
              </section>
            )}

            <section className="mb-12">
              <h2 className="text-2xl font-semibold mb-4">
                {t('Contact Us', translations['Contact'])}
              </h2>
              <p className="text-muted-foreground mb-4">
                {t(
                  "Have questions? We'd love to hear from you!",
                  'هل لديك أسئلة؟ يسعدنا سماعها منك!'
                )}
              </p>
              <Link
                href={storeUrl('/contact')}
                className="inline-flex items-center px-6 py-3 bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors"
              >
                {t('Get in Touch', 'تواصل معنا')}
                <svg className="w-4 h-4 ml-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M9 5l7 7-7 7"
                  />
                </svg>
              </Link>
            </section>
          </div>
        </div>
      </div>
    </ShopChrome>
  );
}
