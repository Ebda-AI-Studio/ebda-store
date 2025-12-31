import Link from 'next/link';
import { Header, Footer } from '../../components';

export default function ShippingPage() {
  return (
    <main className="flex min-h-screen flex-col bg-gray-50">
      <Header />

      <div className="mx-auto w-full max-w-3xl flex-1 px-4 py-12 sm:px-6 lg:px-8">
        <div className="text-center">
          <h1 className="text-3xl font-bold text-gray-900">Shipping Information</h1>
          <p className="mt-2 text-gray-500">
            Everything you need to know about our shipping policies
          </p>
        </div>

        <div className="mt-12 space-y-8">
          <section className="rounded-xl border bg-white p-6 shadow-sm">
            <h2 className="text-xl font-semibold text-gray-900">Shipping Options</h2>
            <div className="mt-4 space-y-4">
              <div className="flex items-start gap-4 rounded-lg bg-gray-50 p-4">
                <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-primary/10">
                  <svg
                    className="h-5 w-5 text-primary"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
                    />
                  </svg>
                </div>
                <div>
                  <h3 className="font-medium text-gray-900">Standard Shipping</h3>
                  <p className="text-sm text-gray-500">5-7 business days</p>
                  <p className="mt-1 text-sm font-medium text-primary">FREE on orders over $50</p>
                </div>
              </div>
              <div className="flex items-start gap-4 rounded-lg bg-gray-50 p-4">
                <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-primary/10">
                  <svg
                    className="h-5 w-5 text-primary"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M13 10V3L4 14h7v7l9-11h-7z"
                    />
                  </svg>
                </div>
                <div>
                  <h3 className="font-medium text-gray-900">Express Shipping</h3>
                  <p className="text-sm text-gray-500">2-3 business days</p>
                  <p className="mt-1 text-sm font-medium text-gray-700">$9.99</p>
                </div>
              </div>
              <div className="flex items-start gap-4 rounded-lg bg-gray-50 p-4">
                <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-primary/10">
                  <svg
                    className="h-5 w-5 text-primary"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                    />
                  </svg>
                </div>
                <div>
                  <h3 className="font-medium text-gray-900">Next Day Delivery</h3>
                  <p className="text-sm text-gray-500">1 business day</p>
                  <p className="mt-1 text-sm font-medium text-gray-700">$19.99</p>
                </div>
              </div>
            </div>
          </section>

          <section className="rounded-xl border bg-white p-6 shadow-sm">
            <h2 className="text-xl font-semibold text-gray-900">International Shipping</h2>
            <p className="mt-2 text-gray-600">
              We ship to over 50 countries worldwide. International shipping rates and delivery
              times vary by destination:
            </p>
            <ul className="mt-4 space-y-2 text-gray-600">
              <li className="flex items-center gap-2">
                <svg
                  className="h-4 w-4 text-primary"
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
                Canada &amp; Mexico: 7-10 business days
              </li>
              <li className="flex items-center gap-2">
                <svg
                  className="h-4 w-4 text-primary"
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
                Europe: 10-14 business days
              </li>
              <li className="flex items-center gap-2">
                <svg
                  className="h-4 w-4 text-primary"
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
                Middle East: 7-12 business days
              </li>
              <li className="flex items-center gap-2">
                <svg
                  className="h-4 w-4 text-primary"
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
                Asia Pacific: 12-18 business days
              </li>
            </ul>
          </section>

          <section className="rounded-xl border bg-white p-6 shadow-sm">
            <h2 className="text-xl font-semibold text-gray-900">Order Tracking</h2>
            <p className="mt-2 text-gray-600">
              Once your order ships, you&apos;ll receive an email with your tracking number. You can
              track your package using:
            </p>
            <ul className="mt-4 space-y-2 text-gray-600">
              <li className="flex items-center gap-2">
                <svg
                  className="h-4 w-4 text-primary"
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
                The tracking link in your shipping confirmation email
              </li>
              <li className="flex items-center gap-2">
                <svg
                  className="h-4 w-4 text-primary"
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
                Your account order history (if logged in)
              </li>
              <li className="flex items-center gap-2">
                <svg
                  className="h-4 w-4 text-primary"
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
                The carrier&apos;s website directly
              </li>
            </ul>
          </section>
        </div>

        <div className="mt-8 text-center">
          <p className="text-gray-500">
            Have questions about shipping?{' '}
            <Link href="/contact" className="text-primary hover:underline">
              Contact us
            </Link>
          </p>
        </div>
      </div>

      <Footer />
    </main>
  );
}
