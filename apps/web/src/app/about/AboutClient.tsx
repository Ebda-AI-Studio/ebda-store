'use client';

import Link from '../../components/StoreLink';
import { CmsPageContent, ShopChrome } from '../../components';
import { useStore, useStoreUrl } from '../../contexts/StoreContext';
import { useLanguage } from '../../contexts/LanguageContext';

/**
 * About page. When the merchant has authored content under the `about`
 * slug in the Pages CMS, that markdown renders here. Otherwise we fall
 * back to the legacy thin layout — store name + description + contact
 * details + a Contact CTA — so stores that haven't migrated content
 * don't lose their About page overnight.
 */
function AboutFallback() {
  const { store } = useStore();
  const storeUrl = useStoreUrl();
  const { t, language } = useLanguage();

  const isRtl = language === 'ar';
  const brandName =
    (isRtl ? store.nameAr : store.name) || store.name || store.nameAr || t('our store', 'متجرنا');

  const description =
    (isRtl ? store.descriptionAr : store.description) || store.description || store.descriptionAr;

  const hasContactDetails = !!(store.email || store.phone || store.address);

  return (
    <div className="container mx-auto px-4 py-12 sm:py-16">
      <div className="max-w-3xl mx-auto">
        <h1 className="text-3xl sm:text-4xl font-bold mb-6 text-foreground">{brandName}</h1>

        {/* STORE-QA-47: a store with no description still gets a real sentence, never a bare heading. */}
        <p className="text-base sm:text-lg text-muted-foreground leading-relaxed mb-12">
          {description ||
            t(
              `Welcome to ${brandName}. Browse our collection and message us any time if you need help choosing.`,
              `أهلاً بيك في ${brandName}. اتفرج على مجموعتنا وكلّمنا في أي وقت لو محتاج مساعدة في الاختيار.`
            )}
        </p>

        {hasContactDetails && (
          <section className="mb-12">
            <h2 className="text-xl sm:text-2xl font-semibold mb-4 text-foreground">
              {t('Get In Touch', 'تواصل معنا')}
            </h2>
            <ul className="space-y-2 text-sm sm:text-base text-muted-foreground">
              {store.email && (
                <li>
                  <span className="font-medium text-foreground">
                    {t('Email:', 'البريد الإلكتروني:')}
                  </span>{' '}
                  <a href={`mailto:${store.email}`} className="text-primary hover:underline">
                    {store.email}
                  </a>
                </li>
              )}
              {store.phone && (
                <li>
                  <span className="font-medium text-foreground">
                    {t('Phone:', 'رقم الموبايل:')}
                  </span>{' '}
                  <a href={`tel:${store.phone}`} className="text-primary hover:underline" dir="ltr">
                    {store.phone}
                  </a>
                </li>
              )}
              {store.address && (
                <li>
                  <span className="font-medium text-foreground">{t('Address:', 'العنوان:')}</span>{' '}
                  {store.address}
                </li>
              )}
            </ul>
          </section>
        )}

        <Link
          href={storeUrl('/contact')}
          className="inline-flex items-center px-6 py-3 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors font-medium"
        >
          {t('Contact us', 'تواصل معنا')}
          <svg
            className={`w-4 h-4 ms-2 ${isRtl ? 'rotate-180' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </Link>
      </div>
    </div>
  );
}

export default function AboutClient() {
  return (
    <ShopChrome>
      <CmsPageContent
        slug="about"
        defaultTitle={{ en: 'About Us', ar: 'عن المتجر' }}
        fallback={() => <AboutFallback />}
      />
    </ShopChrome>
  );
}
