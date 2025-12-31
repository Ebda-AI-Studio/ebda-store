import Link from 'next/link';
import { Header, Footer } from '../../components';

export default function ReturnsPage() {
  return (
    <main className="flex min-h-screen flex-col bg-gray-50">
      <Header />

      <div className="mx-auto w-full max-w-3xl flex-1 px-4 py-12 sm:px-6 lg:px-8">
        <div className="text-center">
          <h1 className="text-3xl font-bold text-gray-900">Returns &amp; Refunds</h1>
          <p className="mt-2 text-gray-500">Our hassle-free return policy</p>
        </div>

        <div className="mt-12 space-y-8">
          <section className="rounded-xl border bg-white p-6 shadow-sm">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-green-100">
                <svg
                  className="h-5 w-5 text-green-600"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M5 13l4 4L19 7"
                  />
                </svg>
              </div>
              <h2 className="text-xl font-semibold text-gray-900">30-Day Return Policy</h2>
            </div>
            <p className="mt-4 text-gray-600">
              We want you to be completely satisfied with your purchase. If you&apos;re not happy
              with your order, you can return it within 30 days of delivery for a full refund or
              exchange.
            </p>
          </section>

          <section className="rounded-xl border bg-white p-6 shadow-sm">
            <h2 className="text-xl font-semibold text-gray-900">Return Eligibility</h2>
            <p className="mt-2 text-gray-600">To be eligible for a return, items must be:</p>
            <ul className="mt-4 space-y-3">
              <li className="flex items-start gap-3">
                <svg
                  className="mt-0.5 h-5 w-5 flex-shrink-0 text-primary"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M5 13l4 4L19 7"
                  />
                </svg>
                <span className="text-gray-600">Unused and in original condition</span>
              </li>
              <li className="flex items-start gap-3">
                <svg
                  className="mt-0.5 h-5 w-5 flex-shrink-0 text-primary"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M5 13l4 4L19 7"
                  />
                </svg>
                <span className="text-gray-600">In original packaging with all tags attached</span>
              </li>
              <li className="flex items-start gap-3">
                <svg
                  className="mt-0.5 h-5 w-5 flex-shrink-0 text-primary"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M5 13l4 4L19 7"
                  />
                </svg>
                <span className="text-gray-600">
                  Accompanied by the original receipt or proof of purchase
                </span>
              </li>
            </ul>
          </section>

          <section className="rounded-xl border bg-white p-6 shadow-sm">
            <h2 className="text-xl font-semibold text-gray-900">How to Return an Item</h2>
            <div className="mt-4 space-y-4">
              <div className="flex gap-4">
                <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-primary text-sm font-bold text-white">
                  1
                </div>
                <div>
                  <h3 className="font-medium text-gray-900">Contact Us</h3>
                  <p className="text-sm text-gray-600">
                    Email us at returns@forcemedia.com with your order number and reason for return.
                  </p>
                </div>
              </div>
              <div className="flex gap-4">
                <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-primary text-sm font-bold text-white">
                  2
                </div>
                <div>
                  <h3 className="font-medium text-gray-900">Get Return Label</h3>
                  <p className="text-sm text-gray-600">
                    We&apos;ll send you a prepaid return shipping label via email.
                  </p>
                </div>
              </div>
              <div className="flex gap-4">
                <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-primary text-sm font-bold text-white">
                  3
                </div>
                <div>
                  <h3 className="font-medium text-gray-900">Ship the Item</h3>
                  <p className="text-sm text-gray-600">
                    Pack the item securely and drop it off at any authorized shipping location.
                  </p>
                </div>
              </div>
              <div className="flex gap-4">
                <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-primary text-sm font-bold text-white">
                  4
                </div>
                <div>
                  <h3 className="font-medium text-gray-900">Receive Refund</h3>
                  <p className="text-sm text-gray-600">
                    Once we receive and inspect the item, we&apos;ll process your refund within 5-7
                    business days.
                  </p>
                </div>
              </div>
            </div>
          </section>

          <section className="rounded-xl border bg-white p-6 shadow-sm">
            <h2 className="text-xl font-semibold text-gray-900">Refund Information</h2>
            <ul className="mt-4 space-y-2 text-gray-600">
              <li>Refunds will be credited to your original payment method</li>
              <li>Please allow 5-7 business days for the refund to appear</li>
              <li>Original shipping costs are non-refundable (unless the item was defective)</li>
              <li>Sale items are final sale and cannot be returned</li>
            </ul>
          </section>
        </div>

        <div className="mt-8 text-center">
          <p className="text-gray-500">
            Need help with a return?{' '}
            <Link href="/contact" className="text-primary hover:underline">
              Contact our support team
            </Link>
          </p>
        </div>
      </div>

      <Footer />
    </main>
  );
}
