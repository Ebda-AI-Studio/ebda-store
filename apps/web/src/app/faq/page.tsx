'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Header, Footer } from '../../components';

const faqs = [
  {
    question: 'How do I place an order?',
    answer: 'Simply browse our products, add items to your cart, and proceed to checkout. You can pay securely using your credit card through our Stripe integration.',
  },
  {
    question: 'What payment methods do you accept?',
    answer: 'We accept all major credit cards (Visa, MasterCard, American Express) through our secure Stripe payment gateway.',
  },
  {
    question: 'How long does shipping take?',
    answer: 'Standard shipping typically takes 5-7 business days. Express shipping is available for 2-3 business day delivery.',
  },
  {
    question: 'Do you offer international shipping?',
    answer: 'Yes! We ship to over 50 countries worldwide. Shipping costs and delivery times vary by location.',
  },
  {
    question: 'What is your return policy?',
    answer: 'We offer a 30-day return policy for all unused items in original packaging. Please visit our Returns page for more details.',
  },
  {
    question: 'How can I track my order?',
    answer: 'Once your order ships, you\'ll receive an email with a tracking number. You can use this to track your package on the carrier\'s website.',
  },
  {
    question: 'Can I cancel or modify my order?',
    answer: 'Orders can be cancelled or modified within 1 hour of placement. After that, please contact our support team for assistance.',
  },
  {
    question: 'Do you offer gift wrapping?',
    answer: 'Yes! Gift wrapping is available at checkout for a small additional fee. You can also include a personalized message.',
  },
];

export default function FAQPage() {
  const [openIndex, setOpenIndex] = useState<number | null>(0);

  return (
    <main className="flex min-h-screen flex-col bg-gray-50">
      <Header />

      <div className="mx-auto w-full max-w-3xl flex-1 px-4 py-12 sm:px-6 lg:px-8">
        <div className="text-center">
          <h1 className="text-3xl font-bold text-gray-900">Frequently Asked Questions</h1>
          <p className="mt-2 text-gray-500">
            Find answers to common questions about our store
          </p>
        </div>

        <div className="mt-12 space-y-4">
          {faqs.map((faq, index) => (
            <div key={index} className="rounded-xl border bg-white shadow-sm">
              <button
                onClick={() => setOpenIndex(openIndex === index ? null : index)}
                className="flex w-full items-center justify-between p-6 text-left"
              >
                <span className="font-medium text-gray-900">{faq.question}</span>
                <svg
                  className={`h-5 w-5 text-gray-500 transition-transform ${openIndex === index ? 'rotate-180' : ''}`}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              {openIndex === index && (
                <div className="border-t px-6 py-4">
                  <p className="text-gray-600">{faq.answer}</p>
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="mt-12 rounded-xl border bg-white p-8 text-center shadow-sm">
          <h2 className="text-xl font-semibold text-gray-900">Still have questions?</h2>
          <p className="mt-2 text-gray-500">
            Can&apos;t find the answer you&apos;re looking for? Please contact our support team.
          </p>
          <Link
            href="/contact"
            className="mt-4 inline-flex items-center gap-2 text-primary hover:underline"
          >
            Contact Us
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
