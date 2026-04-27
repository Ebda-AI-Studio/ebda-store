'use client';

import Link from 'next/link';
import { ShopChrome } from '../../components';
import { useStore, useStoreUrl } from '../../contexts/StoreContext';
import { useLanguage } from '../../contexts/LanguageContext';

/**
 * About page. Everything below the heading is opt-in: the merchant has to
 * fill in `store.description` (or `store.descriptionAr`) for the body to
 * render, and the contact block only shows when at least one of email /
 * phone / address is set. The previous version shipped hardcoded sections
 * (Our Story / Our Mission / Why Choose Us / 24-7 Support) that didn't
 * apply to every tenant — those have been removed because the spec for
 * this project is that nothing user-facing is hardcoded marketing copy.
 *
 * If a store wants the long-form story / mission / benefits sections back,
 * those should be added as proper editable fields in the admin (e.g. a
 * `pages.about` JSON blob) rather than baked into the template.
 */
export default function AboutClient() {
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
    <ShopChrome>
      <div className="container mx-auto px-4 py-12 sm:py-16">
        <div className="max-w-3xl mx-auto">
          <h1 className="text-3xl sm:text-4xl font-bold mb-6 text-foreground">{brandName}</h1>

          {description && (
            <p className="text-base sm:text-lg text-muted-foreground leading-relaxed mb-12">
              {description}
            </p>
          )}

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
                    <span className="font-medium text-foreground">{t('Phone:', 'الهاتف:')}</span>{' '}
                    <a
                      href={`tel:${store.phone}`}
                      className="text-primary hover:underline"
                      dir="ltr"
                    >
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
    </ShopChrome>
  );
}
