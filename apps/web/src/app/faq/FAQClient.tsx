'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ShopChrome } from '../../components';
import { useStore, useStoreUrl } from '../../contexts/StoreContext';
import { useLanguage } from '../../contexts/LanguageContext';

// Generic fallback FAQs — shown only when the store hasn't authored any
// store-specific FAQs via the admin FAQ manager.
const GENERIC_FAQS = [
  {
    question: 'How do I place an order?',
    questionAr: 'كيف أقوم بتقديم طلب؟',
    answer:
      'Simply browse our products, add items to your cart, and proceed to checkout. You can pay securely using your preferred payment method.',
    answerAr:
      'ما عليك سوى تصفح منتجاتنا وإضافة العناصر إلى سلتك والمتابعة إلى الدفع. يمكنك الدفع بأمان باستخدام طريقة الدفع المفضلة لديك.',
  },
  {
    question: 'What payment methods do you accept?',
    questionAr: 'ما هي طرق الدفع المقبولة؟',
    answer:
      'We accept a variety of payment methods including debit and credit cards and Cash on Delivery. All online payments are processed through a secure payment gateway.',
    answerAr:
      'نقبل مجموعة متنوعة من طرق الدفع بما في ذلك بطاقات الخصم والائتمان والدفع عند الاستلام. تتم معالجة جميع المدفوعات عبر الإنترنت من خلال بوابة دفع آمنة.',
  },
  {
    question: 'How long does shipping take?',
    questionAr: 'كم يستغرق الشحن؟',
    answer:
      'Delivery times depend on your location and the shipping option selected at checkout. Please visit our Shipping page for full details.',
    answerAr:
      'تعتمد أوقات التوصيل على موقعك وخيار الشحن المحدد عند الدفع. يرجى زيارة صفحة الشحن لمزيد من التفاصيل.',
  },
  {
    question: 'What is your return policy?',
    questionAr: 'ما هي سياسة الإرجاع لديكم؟',
    answer:
      'We offer a 30-day return policy for all unused items in original packaging. Please visit our Returns page for more details.',
    answerAr:
      'نقدم سياسة إرجاع لمدة 30 يوماً لجميع العناصر غير المستخدمة في عبوتها الأصلية. يرجى زيارة صفحة المرتجعات لمزيد من التفاصيل.',
  },
  {
    question: 'How can I track my order?',
    questionAr: 'كيف يمكنني تتبع طلبي؟',
    answer:
      "Once your order ships, you'll receive an email with a tracking number. You can use this to track your package on the carrier's website or through your account order history.",
    answerAr:
      'بمجرد شحن طلبك، ستتلقى بريداً إلكترونياً يحتوي على رقم التتبع. يمكنك استخدامه لتتبع طردك على موقع شركة الشحن أو من خلال سجل طلباتك.',
  },
  {
    question: 'Can I cancel or modify my order?',
    questionAr: 'هل يمكنني إلغاء أو تعديل طلبي؟',
    answer:
      'Orders can be cancelled or modified within 1 hour of placement. After that, please contact our support team for assistance.',
    answerAr:
      'يمكن إلغاء أو تعديل الطلبات خلال ساعة واحدة من تقديمها. بعد ذلك، يرجى التواصل مع فريق الدعم للمساعدة.',
  },
  {
    question: 'Do you offer gift wrapping?',
    questionAr: 'هل تقدمون خدمة تغليف الهدايا؟',
    answer:
      'Gift wrapping may be available at checkout for a small additional fee. You can also include a personalized message.',
    answerAr:
      'قد يكون تغليف الهدايا متاحاً عند الدفع مقابل رسوم إضافية بسيطة. يمكنك أيضاً تضمين رسالة شخصية.',
  },
  {
    question: 'How do I contact customer support?',
    questionAr: 'كيف أتواصل مع خدمة العملاء؟',
    answer:
      'You can reach us through the Contact page on our website. We aim to respond to all enquiries as quickly as possible.',
    answerAr:
      'يمكنك التواصل معنا من خلال صفحة اتصل بنا على موقعنا. نسعى للرد على جميع الاستفسارات في أسرع وقت ممكن.',
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
          answer: t(f.answer, f.answerAr),
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
            {t('Still have questions?', 'لا تزال لديك أسئلة؟')}
          </h2>
          <p className="mt-2 text-muted-foreground">
            {t(
              "Can't find the answer you're looking for? Please contact our support team.",
              'لم تجد الإجابة التي تبحث عنها؟ يرجى التواصل مع فريق الدعم.'
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
