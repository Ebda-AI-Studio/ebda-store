'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ShopChrome } from '../../components';
import { useStore, useStoreUrl } from '../../contexts/StoreContext';
import { useLanguage } from '../../contexts/LanguageContext';

// Generic FAQs -- no store-specific content here.
// Payment methods reference the store's configured options; adjust if needed.
const faqs = [
  {
    question: 'How do I place an order?',
    questionAr:
      '\u0643\u064a\u0641 \u0623\u0642\u0648\u0645 \u0628\u062a\u0642\u062f\u064a\u0645 \u0637\u0644\u0628\u061f',
    answer:
      'Simply browse our products, add items to your cart, and proceed to checkout. You can pay securely using your preferred payment method.',
    answerAr:
      '\u0645\u0627 \u0639\u0644\u064a\u0643 \u0633\u0648\u0649 \u062a\u0635\u0641\u062d \u0645\u0646\u062a\u062c\u0627\u062a\u0646\u0627 \u0648\u0625\u0636\u0627\u0641\u0629 \u0627\u0644\u0639\u0646\u0627\u0635\u0631 \u0625\u0644\u0649 \u0633\u0644\u062a\u0643 \u0648\u0627\u0644\u0645\u062a\u0627\u0628\u0639\u0629 \u0625\u0644\u0649 \u0627\u0644\u062f\u0641\u0639. \u064a\u0645\u0643\u0646\u0643 \u0627\u0644\u062f\u0641\u0639 \u0628\u0623\u0645\u0627\u0646 \u0628\u0627\u0633\u062a\u062e\u062f\u0627\u0645 \u0637\u0631\u064a\u0642\u0629 \u0627\u0644\u062f\u0641\u0639 \u0627\u0644\u0645\u0641\u0636\u0644\u0629 \u0644\u062f\u064a\u0643.',
  },
  {
    question: 'What payment methods do you accept?',
    questionAr:
      '\u0645\u0627 \u0647\u064a \u0637\u0631\u0642 \u0627\u0644\u062f\u0641\u0639 \u0627\u0644\u0645\u0642\u0628\u0648\u0644\u0629\u061f',
    answer:
      'We accept a variety of payment methods including debit and credit cards and Cash on Delivery. All online payments are processed through a secure payment gateway.',
    answerAr:
      '\u0646\u0642\u0628\u0644 \u0645\u062c\u0645\u0648\u0639\u0629 \u0645\u062a\u0646\u0648\u0639\u0629 \u0645\u0646 \u0637\u0631\u0642 \u0627\u0644\u062f\u0641\u0639 \u0628\u0645\u0627 \u0641\u064a \u0630\u0644\u0643 \u0628\u0637\u0627\u0642\u0627\u062a \u0627\u0644\u062e\u0635\u0645 \u0648\u0627\u0644\u0627\u0626\u062a\u0645\u0627\u0646 \u0648\u0627\u0644\u062f\u0641\u0639 \u0639\u0646\u062f \u0627\u0644\u0627\u0633\u062a\u0644\u0627\u0645. \u062a\u062a\u0645 \u0645\u0639\u0627\u0644\u062c\u0629 \u062c\u0645\u064a\u0639 \u0627\u0644\u0645\u062f\u0641\u0648\u0639\u0627\u062a \u0639\u0628\u0631 \u0627\u0644\u0625\u0646\u062a\u0631\u0646\u062a \u0645\u0646 \u062e\u0644\u0627\u0644 \u0628\u0648\u0627\u0628\u0629 \u062f\u0641\u0639 \u0622\u0645\u0646\u0629.',
  },
  {
    question: 'How long does shipping take?',
    questionAr:
      '\u0643\u0645 \u064a\u0633\u062a\u063a\u0631\u0642 \u0627\u0644\u0634\u062d\u0646\u061f',
    answer:
      'Delivery times depend on your location and the shipping option selected at checkout. Please visit our Shipping page for full details.',
    answerAr:
      '\u062a\u0639\u062a\u0645\u062f \u0623\u0648\u0642\u0627\u062a \u0627\u0644\u062a\u0648\u0635\u064a\u0644 \u0639\u0644\u0649 \u0645\u0648\u0642\u0639\u0643 \u0648\u062e\u064a\u0627\u0631 \u0627\u0644\u0634\u062d\u0646 \u0627\u0644\u0645\u062d\u062f\u062f \u0639\u0646\u062f \u0627\u0644\u062f\u0641\u0639. \u064a\u0631\u062c\u0649 \u0632\u064a\u0627\u0631\u0629 \u0635\u0641\u062d\u0629 \u0627\u0644\u0634\u062d\u0646 \u0644\u0645\u0632\u064a\u062f \u0645\u0646 \u0627\u0644\u062a\u0641\u0627\u0635\u064a\u0644.',
  },
  {
    question: 'What is your return policy?',
    questionAr:
      '\u0645\u0627 \u0647\u064a \u0633\u064a\u0627\u0633\u0629 \u0627\u0644\u0625\u0631\u062c\u0627\u0639 \u0644\u062f\u064a\u0643\u0645\u061f',
    answer:
      'We offer a 30-day return policy for all unused items in original packaging. Please visit our Returns page for more details.',
    answerAr:
      '\u0646\u0642\u062f\u0645 \u0633\u064a\u0627\u0633\u0629 \u0625\u0631\u062c\u0627\u0639 \u0644\u0645\u062f\u0629 30 \u064a\u0648\u0645\u0627\u064b \u0644\u062c\u0645\u064a\u0639 \u0627\u0644\u0639\u0646\u0627\u0635\u0631 \u063a\u064a\u0631 \u0627\u0644\u0645\u0633\u062a\u062e\u062f\u0645\u0629 \u0641\u064a \u0639\u0628\u0648\u062a\u0647\u0627 \u0627\u0644\u0623\u0635\u0644\u064a\u0629. \u064a\u0631\u062c\u0649 \u0632\u064a\u0627\u0631\u0629 \u0635\u0641\u062d\u0629 \u0627\u0644\u0645\u0631\u062a\u062c\u0639\u0627\u062a \u0644\u0645\u0632\u064a\u062f \u0645\u0646 \u0627\u0644\u062a\u0641\u0627\u0635\u064a\u0644.',
  },
  {
    question: 'How can I track my order?',
    questionAr:
      '\u0643\u064a\u0641 \u064a\u0645\u0643\u0646\u0646\u064a \u062a\u062a\u0628\u0639 \u0637\u0644\u0628\u064a\u061f',
    answer:
      "Once your order ships, you'll receive an email with a tracking number. You can use this to track your package on the carrier's website or through your account order history.",
    answerAr:
      '\u0628\u0645\u062c\u0631\u062f \u0634\u062d\u0646 \u0637\u0644\u0628\u0643\u060c \u0633\u062a\u062a\u0644\u0642\u0649 \u0628\u0631\u064a\u062f\u0627\u064b \u0625\u0644\u0643\u062a\u0631\u0648\u0646\u064a\u0627\u064b \u064a\u062d\u062a\u0648\u064a \u0639\u0644\u0649 \u0631\u0642\u0645 \u0627\u0644\u062a\u062a\u0628\u0639. \u064a\u0645\u0643\u0646\u0643 \u0627\u0633\u062a\u062e\u062f\u0627\u0645\u0647 \u0644\u062a\u062a\u0628\u0639 \u0637\u0631\u062f\u0643 \u0639\u0644\u0649 \u0645\u0648\u0642\u0639 \u0634\u0631\u0643\u0629 \u0627\u0644\u0634\u062d\u0646 \u0623\u0648 \u0645\u0646 \u062e\u0644\u0627\u0644 \u0633\u062c\u0644 \u0637\u0644\u0628\u0627\u062a\u0643.',
  },
  {
    question: 'Can I cancel or modify my order?',
    questionAr:
      '\u0647\u0644 \u064a\u0645\u0643\u0646\u0646\u064a \u0625\u0644\u063a\u0627\u0621 \u0623\u0648 \u062a\u0639\u062f\u064a\u0644 \u0637\u0644\u0628\u064a\u061f',
    answer:
      'Orders can be cancelled or modified within 1 hour of placement. After that, please contact our support team for assistance.',
    answerAr:
      '\u064a\u0645\u0643\u0646 \u0625\u0644\u063a\u0627\u0621 \u0623\u0648 \u062a\u0639\u062f\u064a\u0644 \u0627\u0644\u0637\u0644\u0628\u0627\u062a \u062e\u0644\u0627\u0644 \u0633\u0627\u0639\u0629 \u0648\u0627\u062d\u062f\u0629 \u0645\u0646 \u062a\u0642\u062f\u064a\u0645\u0647\u0627. \u0628\u0639\u062f \u0630\u0644\u0643\u060c \u064a\u0631\u062c\u0649 \u0627\u0644\u062a\u0648\u0627\u0635\u0644 \u0645\u0639 \u0641\u0631\u064a\u0642 \u0627\u0644\u062f\u0639\u0645 \u0644\u0644\u0645\u0633\u0627\u0639\u062f\u0629.',
  },
  {
    question: 'Do you offer gift wrapping?',
    questionAr:
      '\u0647\u0644 \u062a\u0642\u062f\u0645\u0648\u0646 \u062e\u062f\u0645\u0629 \u062a\u063a\u0644\u064a\u0641 \u0627\u0644\u0647\u062f\u0627\u064a\u0627\u061f',
    answer:
      'Gift wrapping may be available at checkout for a small additional fee. You can also include a personalized message.',
    answerAr:
      '\u0642\u062f \u064a\u0643\u0648\u0646 \u062a\u063a\u0644\u064a\u0641 \u0627\u0644\u0647\u062f\u0627\u064a\u0627 \u0645\u062a\u0627\u062d\u0627\u064b \u0639\u0646\u062f \u0627\u0644\u062f\u0641\u0639 \u0645\u0642\u0627\u0628\u0644 \u0631\u0633\u0648\u0645 \u0625\u0636\u0627\u0641\u064a\u0629 \u0628\u0633\u064a\u0637\u0629. \u064a\u0645\u0643\u0646\u0643 \u0623\u064a\u0636\u0627\u064b \u062a\u0636\u0645\u064a\u0646 \u0631\u0633\u0627\u0644\u0629 \u0634\u062e\u0635\u064a\u0629.',
  },
  {
    question: 'How do I contact customer support?',
    questionAr:
      '\u0643\u064a\u0641 \u0623\u062a\u0648\u0627\u0635\u0644 \u0645\u0639 \u062e\u062f\u0645\u0629 \u0627\u0644\u0639\u0645\u0644\u0627\u0621\u061f',
    answer:
      'You can reach us through the Contact page on our website. We aim to respond to all enquiries as quickly as possible.',
    answerAr:
      '\u064a\u0645\u0643\u0646\u0643 \u0627\u0644\u062a\u0648\u0627\u0635\u0644 \u0645\u0639\u0646\u0627 \u0645\u0646 \u062e\u0644\u0627\u0644 \u0635\u0641\u062d\u0629 \u0627\u062a\u0635\u0644 \u0628\u0646\u0627 \u0639\u0644\u0649 \u0645\u0648\u0642\u0639\u0646\u0627. \u0646\u0633\u0639\u0649 \u0644\u0644\u0631\u062f \u0639\u0644\u0649 \u062c\u0645\u064a\u0639 \u0627\u0644\u0627\u0633\u062a\u0641\u0633\u0627\u0631\u0627\u062a \u0641\u064a \u0623\u0633\u0631\u0639 \u0648\u0642\u062a \u0645\u0645\u0643\u0646.',
  },
];

export default function FAQClient() {
  const { store } = useStore();
  const storeUrl = useStoreUrl();
  const { t } = useLanguage();
  const [openIndex, setOpenIndex] = useState<number | null>(0);

  return (
    <ShopChrome>
      <div className="mx-auto w-full max-w-3xl flex-1 px-4 py-12 sm:px-6 lg:px-8">
        <div className="text-center">
          <h1 className="text-3xl font-bold text-foreground">
            {t(
              'Frequently Asked Questions',
              '\u0627\u0644\u0623\u0633\u0626\u0644\u0629 \u0627\u0644\u0634\u0627\u0626\u0639\u0629'
            )}
          </h1>
          <p className="mt-2 text-muted-foreground">
            {t(
              `Find answers to common questions about ${store.name || 'our store'}`,
              `\u0627\u0639\u062b\u0631 \u0639\u0644\u0649 \u0625\u062c\u0627\u0628\u0627\u062a \u0644\u0644\u0623\u0633\u0626\u0644\u0629 \u0627\u0644\u0634\u0627\u0626\u0639\u0629 \u062d\u0648\u0644 ${store.name || '\u0645\u062a\u062c\u0631\u0646\u0627'}`
            )}
          </p>
        </div>

        <div className="mt-12 space-y-4">
          {faqs.map((faq, index) => (
            <div key={index} className="rounded-xl border bg-card shadow-sm">
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

        <div className="mt-12 rounded-xl border bg-card p-8 text-center shadow-sm">
          <h2 className="text-xl font-semibold text-foreground">
            {t(
              'Still have questions?',
              '\u0644\u0627 \u062a\u0632\u0627\u0644 \u0644\u062f\u064a\u0643 \u0623\u0633\u0626\u0644\u0629\u061f'
            )}
          </h2>
          <p className="mt-2 text-muted-foreground">
            {t(
              "Can't find the answer you're looking for? Please contact our support team.",
              '\u0644\u0645 \u062a\u062c\u062f \u0627\u0644\u0625\u062c\u0627\u0628\u0629 \u0627\u0644\u062a\u064a \u062a\u0628\u062d\u062b \u0639\u0646\u0647\u0627\u061f \u064a\u0631\u062c\u0649 \u0627\u0644\u062a\u0648\u0627\u0635\u0644 \u0645\u0639 \u0641\u0631\u064a\u0642 \u0627\u0644\u062f\u0639\u0645.'
            )}
          </p>
          <Link
            href={storeUrl('/contact')}
            className="mt-4 inline-flex items-center gap-2 text-primary hover:underline"
          >
            {t('Contact Us', '\u062a\u0648\u0627\u0635\u0644 \u0645\u0639\u0646\u0627')}
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </Link>
        </div>
      </div>
    </ShopChrome>
  );
}
