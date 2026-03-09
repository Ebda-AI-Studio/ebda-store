'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Header, Footer } from '../../components';
import { useStore, useStoreUrl } from '../../contexts/StoreContext';
import { useLanguage } from '../../contexts/LanguageContext';

// Generic FAQs — no store-specific content here.
// Payment methods reference the store's configured options; adjust if needed.
const faqs = [
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

export default function FAQPage() {
  const { store } = useStore();
  const storeUrl = useStoreUrl();
  const { t } = useLanguage();
  const [openIndex, setOpenIndex] = useState<number | null>(0);

  return (
    <main className="flex min-h-screen flex-col bg-background">
      <Header />

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

        <div className="mt-12 space-y-4">
          {faqs.map((faq, index) => (
            <div key={index} className="rounded-xl border bg-white shadow-sm">
              <button
                onClick={() => setOpenIndex(openIndex === index ? null : index)}
                className="flex w-full items-center justify-between p-6 text-left"
              >
                <span className="font-medium text-foreground">
                  {t(faq.question, faq.questionAr)}
                </span>
                <svg
                  className={`h-5 w-5 text-muted-foreground transition-transform ${openIndex === index ? 'rotate-180' : ''}`}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
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
                <div className="border-t px-6 py-4">
                  <p className="text-muted-foreground">{t(faq.answer, faq.answerAr)}</p>
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="mt-12 rounded-xl border bg-white p-8 text-center shadow-sm">
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
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </Link>
        </div>
      </div>

      <Footer />
    </main>
  );
}
