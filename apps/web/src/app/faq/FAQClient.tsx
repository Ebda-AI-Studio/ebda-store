'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ShopChrome } from '../../components';
import { useStore, useStoreUrl } from '../../contexts/StoreContext';
import { useLanguage } from '../../contexts/LanguageContext';
import { faqReturnAnswer } from '../../lib/return-policy-text';
import { useNumerals } from '../../hooks/useNumerals';

// Generic fallback FAQs — shown only when the store hasn't authored any
// store-specific FAQs via the admin FAQ manager.
const GENERIC_FAQS = [
  {
    question: 'How do I place an order?',
    questionAr: 'إزاي أعمل طلب؟',
    answer:
      'Simply browse our products, add items to your cart, and proceed to checkout. You can pay securely using your preferred payment method.',
    answerAr:
      'سهلة: تصفّح منتجاتنا، ضيف اللي عاجبك للسلة، وكمّل للدفع. تقدر تدفع بأمان بالطريقة اللي تريحك.',
  },
  {
    question: 'What payment methods do you accept?',
    questionAr: 'إيه طرق الدفع المتاحة؟',
    answer:
      'We accept a variety of payment methods including debit and credit cards and Cash on Delivery. All online payments are processed through a secure payment gateway.',
    answerAr:
      'بنقبل طرق دفع كتير منها كروت الخصم والائتمان والدفع عند الاستلام. كل المدفوعات أونلاين بتتم من خلال بوابة دفع آمنة.',
  },
  {
    question: 'How long does shipping take?',
    questionAr: 'كم يستغرق الشحن؟',
    answer:
      'Delivery times depend on your location and the shipping option selected at checkout. Please visit our Shipping page for full details.',
    answerAr:
      'مواعيد التوصيل بتختلف حسب مكانك وطريقة الشحن اللي بتختارها وقت الدفع. شوف صفحة الشحن لتفاصيل أكتر.',
  },
  {
    question: 'What is your return policy?',
    questionAr: 'إيه سياسة الإرجاع عندكم؟',
    answer:
      'We offer a 30-day return policy for all unused items in original packaging. Please visit our Returns page for more details.',
    answerAr:
      'بنقبل الإرجاع خلال 30 يوم لكل المنتجات اللي متستعملتش وفي علبتها الأصلية. شوف صفحة المرتجعات لتفاصيل أكتر.',
  },
  {
    question: 'How can I track my order?',
    questionAr: 'إزاي أتابع طلبي؟',
    answer:
      "Once your order ships, you'll receive an email with a tracking number. You can use this to track your package on the carrier's website or through your account order history.",
    answerAr:
      'أول ما طلبك يتشحن، هيوصلك إيميل فيه رقم التتبع. تقدر تتابع بيه شحنتك على موقع شركة الشحن أو من سجل طلباتك.',
  },
  {
    question: 'Can I cancel or modify my order?',
    questionAr: 'أقدر ألغي أو أعدّل طلبي؟',
    answer:
      'Orders can be cancelled or modified within 1 hour of placement. After that, please contact our support team for assistance.',
    answerAr:
      'تقدر تلغي أو تعدّل الطلب خلال ساعة من وقت ما تعمله. بعد كده، كلّم فريق الدعم وهيساعدك.',
  },
  {
    question: 'Do you offer gift wrapping?',
    questionAr: 'بتقدموا تغليف هدايا؟',
    answer:
      'Gift wrapping may be available at checkout for a small additional fee. You can also include a personalized message.',
    answerAr: 'ممكن يكون في تغليف هدايا وقت الدفع برسوم إضافية بسيطة. وتقدر كمان تكتب رسالة شخصية.',
  },
  {
    question: 'How do I contact customer support?',
    questionAr: 'إزاي أكلّم خدمة العملاء؟',
    answer:
      'You can reach us through the Contact page on our website. We aim to respond to all enquiries as quickly as possible.',
    answerAr: 'تقدر تكلّمنا من صفحة اتصل بنا على موقعنا. بنحاول نرد على كل الأسئلة في أسرع وقت.',
  },
];

interface StoreFaq {
  id: string;
  question: string;
  questionAr?: string | null;
  answer: string;
  answerAr?: string | null;
}

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

interface FAQClientProps {
  storeFaqs?: StoreFaq[];
  storeHowtos?: StoreHowto[];
}

export default function FAQClient({ storeFaqs = [], storeHowtos = [] }: FAQClientProps) {
  const { store } = useStore();
  const storeUrl = useStoreUrl();
  const { t, language } = useLanguage();
  // Days in the store's digits, the same as the PDP trust line (review M8).
  const { localize } = useNumerals();
  const [openFaqIndex, setOpenFaqIndex] = useState<number | null>(0);
  const [openHowtoIndex, setOpenHowtoIndex] = useState<number | null>(null);

  const isAr = language === 'ar';

  // Use store-authored FAQs when available; otherwise show generic fallback.
  const faqs: Array<{ question: string; answer: string }> =
    storeFaqs.length > 0
      ? storeFaqs.map(f => ({
          question: isAr ? f.questionAr || f.question : f.question,
          answer: isAr ? f.answerAr || f.answer : f.answer,
        }))
      : GENERIC_FAQS.map(f => ({
          question: t(f.question, f.questionAr),
          // The return answer follows the store's published window instead of a hard-coded 30 days.
          answer:
            f.question === 'What is your return policy?'
              ? faqReturnAnswer(store.returnWindowDays, language, localize)
              : t(f.answer, f.answerAr),
        }));

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
            {t('Frequently Asked Questions', 'الأسئلة الشائعة')}
          </h1>
          <p className="mt-2 text-muted-foreground">
            {t(
              `Find answers to common questions about ${store.name || 'our store'}`,
              `اعثر على إجابات للأسئلة الشائعة حول ${store.name || 'متجرنا'}`
            )}
          </p>
        </div>

        {/* FAQ accordion */}
        <div className="mt-12 space-y-4">
          {faqs.map((faq, index) => (
            <div key={index} className="rounded-xl border bg-card shadow-sm">
              <button
                type="button"
                onClick={() => setOpenFaqIndex(openFaqIndex === index ? null : index)}
                aria-expanded={openFaqIndex === index}
                className="flex w-full items-center justify-between p-6 text-left"
              >
                <span className="font-medium text-foreground">{faq.question}</span>
                <svg
                  className={`h-5 w-5 shrink-0 text-muted-foreground transition-transform ${openFaqIndex === index ? 'rotate-180' : ''}`}
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
              {openFaqIndex === index && (
                <div className="border-t px-6 py-4">
                  <p className="whitespace-pre-line text-muted-foreground">{faq.answer}</p>
                </div>
              )}
            </div>
          ))}
        </div>

        {/* HowTo guides — only rendered when store has authored them.
            "See all guides" links to the dedicated /how-to-guides page
            so visitors who land here from search find the full set. */}
        {howtos.length > 0 && (
          <section aria-labelledby="howto-heading" className="mt-16">
            <div className="mb-6 flex items-baseline justify-between gap-3">
              <h2 id="howto-heading" className="text-2xl font-bold text-foreground">
                {t('How-To Guides', 'أدلة إرشادية')}
              </h2>
              <Link
                href={storeUrl('/how-to-guides')}
                prefetch={false}
                className="inline-flex items-center min-h-11 text-sm font-medium text-primary hover:underline"
              >
                {t('See all guides →', 'كل الأدلة ←')}
              </Link>
            </div>
            <div className="space-y-4">
              {howtos.map((h, index) => (
                <div key={index} className="rounded-xl border bg-card shadow-sm">
                  <button
                    type="button"
                    onClick={() => setOpenHowtoIndex(openHowtoIndex === index ? null : index)}
                    aria-expanded={openHowtoIndex === index}
                    className="flex w-full items-center justify-between p-6 text-left"
                  >
                    <span className="font-medium text-foreground">{h.title}</span>
                    <svg
                      className={`h-5 w-5 shrink-0 text-muted-foreground transition-transform ${openHowtoIndex === index ? 'rotate-180' : ''}`}
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
                  {openHowtoIndex === index && (
                    <div className="border-t px-6 py-4">
                      {h.description && (
                        <p className="mb-4 text-muted-foreground">{h.description}</p>
                      )}
                      <ol className="list-decimal space-y-3 pl-5">
                        {h.steps.map((step, si) => (
                          <li key={si}>
                            <span className="font-medium text-foreground">{step.name}</span>
                            {step.text && (
                              <span className="text-muted-foreground">: {step.text}</span>
                            )}
                            {step.image && (
                              <img
                                src={step.image}
                                alt={step.name}
                                className="mt-2 rounded-lg"
                                loading="lazy"
                              />
                            )}
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

        <div className="mt-12 rounded-xl border bg-card p-8 text-center shadow-sm">
          <h2 className="text-xl font-semibold text-foreground">
            {t('Still have questions?', 'لسه عندك أسئلة؟')}
          </h2>
          <p className="mt-2 text-muted-foreground">
            {t(
              "Can't find the answer you're looking for? Please contact our support team.",
              'ملقيتش الإجابة اللي بتدوّر عليها؟ كلّم فريق الدعم.'
            )}
          </p>
          <Link
            href={storeUrl('/contact')}
            className="mt-4 inline-flex items-center gap-2 text-primary hover:underline"
          >
            {t('Contact Us', 'تواصل معنا')}
            <svg
              className="h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              aria-hidden="true"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </Link>
        </div>
      </div>
    </ShopChrome>
  );
}
