'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useLanguage } from '../../contexts/LanguageContext';
import { useStore, useStoreUrl } from '../../contexts/StoreContext';
import { ShopChrome } from '../../components';

interface StoreHowtoStep {
  name: string;
  text: string;
  image?: string;
}

interface StoreHowto {
  id: string;
  title: string;
  titleAr?: string | null;
  description: string;
  descriptionAr?: string | null;
  steps: StoreHowtoStep[];
  stepsAr?: StoreHowtoStep[] | null;
}

interface HowToGuidesClientProps {
  storeHowtos?: StoreHowto[];
}

export default function HowToGuidesClient({ storeHowtos = [] }: HowToGuidesClientProps) {
  const { t, language } = useLanguage();
  const { store } = useStore();
  const storeUrl = useStoreUrl();
  const isAr = language === 'ar';
  const [openIndex, setOpenIndex] = useState<number | null>(0); // first guide open by default

  // Resolve each guide's locale-correct fields.
  const howtos: Array<{ title: string; description: string; steps: StoreHowtoStep[] }> =
    storeHowtos.map(h => ({
      title: isAr ? h.titleAr || h.title : h.title,
      description: isAr ? h.descriptionAr || h.description : h.description,
      steps: isAr && h.stepsAr && h.stepsAr.length > 0 ? h.stepsAr : h.steps,
    }));

  return (
    <ShopChrome>
      <div className="mx-auto w-full max-w-3xl flex-1 px-4 py-12 sm:px-6 lg:px-8">
        <div className="text-center">
          <h1 className="text-3xl font-bold text-foreground">
            {t('How-To Guides', 'أدلة إرشادية')}
          </h1>
          <p className="mt-2 text-muted-foreground">
            {t(
              `Step-by-step guides for ${store?.name || 'our store'} — ordering, returns, payments, and more.`,
              `أدلة خطوة بخطوة لمتجر ${store?.name || 'متجرنا'} — الطلب، الإرجاع، الدفع، والمزيد.`
            )}
          </p>
        </div>

        {/* Guides accordion. First item open on initial render so the page
            doesn't look empty above the fold; user can collapse or open
            others. Mirrors the /faq accordion pattern for consistency. */}
        {howtos.length > 0 ? (
          <div className="mt-12 space-y-4">
            {howtos.map((h, index) => (
              <article
                key={index}
                className="rounded-xl border bg-card shadow-sm"
                aria-labelledby={`howto-${index}-title`}
              >
                <button
                  type="button"
                  onClick={() => setOpenIndex(openIndex === index ? null : index)}
                  aria-expanded={openIndex === index}
                  aria-controls={`howto-${index}-body`}
                  className="flex w-full items-center justify-between p-6 text-left min-h-11"
                >
                  <span id={`howto-${index}-title`} className="font-medium text-foreground">
                    {h.title}
                  </span>
                  <svg
                    className={`h-5 w-5 shrink-0 text-muted-foreground transition-transform ${openIndex === index ? 'rotate-180' : ''}`}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    aria-hidden="true"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M19 9l-7 7-7-7"
                    />
                  </svg>
                </button>
                {openIndex === index && (
                  <div id={`howto-${index}-body`} className="border-t px-6 py-5">
                    {h.description && (
                      <p className="mb-5 whitespace-pre-line text-muted-foreground">
                        {h.description}
                      </p>
                    )}
                    <ol className="space-y-4">
                      {h.steps.map((step, sIdx) => (
                        <li key={sIdx} className="flex gap-3">
                          <span
                            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground"
                            aria-hidden="true"
                          >
                            {sIdx + 1}
                          </span>
                          <div className="flex-1">
                            <p className="font-medium text-foreground">{step.name}</p>
                            {step.text && (
                              <p className="mt-1 whitespace-pre-line text-muted-foreground">
                                {step.text}
                              </p>
                            )}
                          </div>
                        </li>
                      ))}
                    </ol>
                  </div>
                )}
              </article>
            ))}
          </div>
        ) : (
          <div className="mt-12 rounded-xl border bg-card p-12 text-center">
            <p className="text-muted-foreground">
              {t(
                'No how-to guides yet. Check the FAQ for quick answers.',
                'مفيش أدلة لسه. شوف الأسئلة الشائعة لإجابات سريعة.'
              )}
            </p>
            <Link
              href={storeUrl('/faq')}
              prefetch={false}
              className="mt-4 inline-flex items-center min-h-11 text-sm font-medium text-primary hover:underline"
            >
              {t('Browse FAQs →', 'تصفح الأسئلة الشائعة ←')}
            </Link>
          </div>
        )}

        {/* Cross-link out to FAQ so visitors who landed here from search
            also discover the FAQ section. */}
        {howtos.length > 0 && (
          <div className="mt-12 rounded-xl border bg-muted/30 p-6 text-center">
            <p className="text-sm text-muted-foreground">
              {t('Looking for quick answers?', 'بتدوّر على إجابات سريعة؟')}
            </p>
            <Link
              href={storeUrl('/faq')}
              prefetch={false}
              className="mt-2 inline-flex items-center min-h-11 text-sm font-medium text-primary hover:underline"
            >
              {t('Visit the FAQ →', 'زيارة الأسئلة الشائعة ←')}
            </Link>
          </div>
        )}
      </div>
    </ShopChrome>
  );
}
