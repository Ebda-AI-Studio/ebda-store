'use client';

import Link from 'next/link';
import { Header, Footer } from '../../components';
import { useStore, useStoreUrl } from '../../contexts/StoreContext';

export default function AboutPage() {
  const { store } = useStore();
  const storeUrl = useStoreUrl();

  // Prefer a dedicated about/description field; fall back to a generic message
  const headingText = store.name || 'Our Store';
  const descriptionText =
    store.description ||
    `Welcome to ${store.name || 'our store'}! We are passionate about providing high-quality products and exceptional customer service.`;

  return (
    <main className="flex min-h-screen flex-col bg-background">
      <Header />
      <div className="container mx-auto px-4 py-8 flex-1">
        <div className="max-w-4xl mx-auto">
          <h1 className="text-4xl font-bold mb-8">{headingText}</h1>

          <div className="prose prose-lg max-w-none">
            <section className="mb-12">
              <h2 className="text-2xl font-semibold mb-4">Our Story</h2>
              <p className="text-muted-foreground mb-4">{descriptionText}</p>
              <p className="text-muted-foreground">
                Today, we continue to grow and evolve, always keeping our customers at the heart of
                everything we do.
              </p>
            </section>

            <section className="mb-12">
              <h2 className="text-2xl font-semibold mb-4">Our Mission</h2>
              <p className="text-muted-foreground">
                We strive to deliver the best products at competitive prices while maintaining the
                highest standards of customer service. Our team works tirelessly to ensure every
                customer has a seamless shopping experience.
              </p>
            </section>

            <section className="mb-12">
              <h2 className="text-2xl font-semibold mb-4">Why Choose Us?</h2>
              <div className="grid md:grid-cols-3 gap-6 mt-6">
                <div className="bg-muted p-6 rounded-lg">
                  <div className="w-12 h-12 bg-blue-100 rounded-full flex items-center justify-center mb-4">
                    <svg
                      className="w-6 h-6 text-blue-600"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M5 13l4 4L19 7"
                      />
                    </svg>
                  </div>
                  <h3 className="font-semibold mb-2">Quality Products</h3>
                  <p className="text-muted-foreground text-sm">
                    We carefully curate our selection to ensure only the best products reach you.
                  </p>
                </div>
                <div className="bg-muted p-6 rounded-lg">
                  <div className="w-12 h-12 bg-green-100 rounded-full flex items-center justify-center mb-4">
                    <svg
                      className="w-6 h-6 text-green-600"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                      />
                    </svg>
                  </div>
                  <h3 className="font-semibold mb-2">Great Prices</h3>
                  <p className="text-muted-foreground text-sm">
                    Competitive pricing without compromising on quality or service.
                  </p>
                </div>
                <div className="bg-muted p-6 rounded-lg">
                  <div className="w-12 h-12 bg-purple-100 rounded-full flex items-center justify-center mb-4">
                    <svg
                      className="w-6 h-6 text-purple-600"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M18.364 5.636l-3.536 3.536m0 5.656l3.536 3.536M9.172 9.172L5.636 5.636m3.536 9.192l-3.536 3.536M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-5 0a4 4 0 11-8 0 4 4 0 018 0z"
                      />
                    </svg>
                  </div>
                  <h3 className="font-semibold mb-2">24/7 Support</h3>
                  <p className="text-muted-foreground text-sm">
                    Our customer support team is always here to help you.
                  </p>
                </div>
              </div>
            </section>

            {/* Show store contact details if available */}
            {(store.email || store.phone || store.address) && (
              <section className="mb-12">
                <h2 className="text-2xl font-semibold mb-4">Get In Touch</h2>
                <ul className="space-y-2 text-muted-foreground">
                  {store.email && (
                    <li>
                      <span className="font-medium">Email:</span>{' '}
                      <a href={`mailto:${store.email}`} className="text-primary hover:underline">
                        {store.email}
                      </a>
                    </li>
                  )}
                  {store.phone && (
                    <li>
                      <span className="font-medium">Phone:</span>{' '}
                      <a href={`tel:${store.phone}`} className="text-primary hover:underline">
                        {store.phone}
                      </a>
                    </li>
                  )}
                  {store.address && (
                    <li>
                      <span className="font-medium">Address:</span> {store.address}
                    </li>
                  )}
                </ul>
              </section>
            )}

            <section className="mb-12">
              <h2 className="text-2xl font-semibold mb-4">Contact Us</h2>
              <p className="text-muted-foreground mb-4">
                Have questions? We&apos;d love to hear from you!
              </p>
              <Link
                href={storeUrl('/contact')}
                className="inline-flex items-center px-6 py-3 bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors"
              >
                Get in Touch
                <svg className="w-4 h-4 ml-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M9 5l7 7-7 7"
                  />
                </svg>
              </Link>
            </section>
          </div>
        </div>
      </div>
      <Footer />
    </main>
  );
}
