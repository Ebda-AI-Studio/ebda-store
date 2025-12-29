'use client';

import { useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { Button } from '@force/ui';

// Generate order number outside component to avoid impure function in render
const generateOrderNumber = () => `ORD-${Date.now().toString(36).toUpperCase()}`;

export default function CheckoutSuccessPage() {
  const [orderNumber] = useState(generateOrderNumber);

  return (
    <main className="min-h-screen bg-gray-50">
      {/* Navigation */}
      <nav className="border-b bg-white">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-center px-4 sm:px-6 lg:px-8">
          <Link href="/" className="flex items-center gap-2">
            <Image src="/logo.svg" alt="Force Media" width={40} height={30} />
            <span className="text-xl font-bold">
              <span className="text-primary">Force</span>
              <span className="text-gray-700"> Store</span>
            </span>
          </Link>
        </div>
      </nav>

      <div className="mx-auto max-w-2xl px-4 py-16 sm:px-6 lg:px-8">
        <div className="text-center">
          {/* Success Icon */}
          <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-green-100">
            <svg className="h-10 w-10 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>

          <h1 className="mt-6 text-3xl font-bold text-gray-900">Thank you for your order!</h1>
          <p className="mt-2 text-lg text-gray-600">
            Your order has been confirmed and will be shipped soon.
          </p>

          <div className="mt-8 rounded-xl border bg-white p-6 shadow-sm">
            <div className="flex items-center justify-between border-b pb-4">
              <div>
                <p className="text-sm text-gray-500">Order number</p>
                <p className="text-lg font-semibold text-gray-900">{orderNumber}</p>
              </div>
              <div className="text-right">
                <p className="text-sm text-gray-500">Date</p>
                <p className="text-gray-900">{new Date().toLocaleDateString()}</p>
              </div>
            </div>

            <div className="py-4">
              <p className="text-sm text-gray-500">
                We&apos;ll send you a confirmation email with your order details and tracking information
                once your order ships.
              </p>
            </div>

            <div className="border-t pt-4">
              <h3 className="font-medium text-gray-900">What&apos;s next?</h3>
              <ul className="mt-3 space-y-2 text-sm text-gray-600">
                <li className="flex items-center gap-2">
                  <svg className="h-4 w-4 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  Order confirmation email sent
                </li>
                <li className="flex items-center gap-2">
                  <svg className="h-4 w-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  Processing your order
                </li>
                <li className="flex items-center gap-2">
                  <svg className="h-4 w-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
                  </svg>
                  Order shipped (tracking sent via email)
                </li>
                <li className="flex items-center gap-2">
                  <svg className="h-4 w-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
                  </svg>
                  Delivered to your doorstep
                </li>
              </ul>
            </div>
          </div>

          <div className="mt-8 flex flex-col gap-4 sm:flex-row sm:justify-center">
            <Link href="/products">
              <Button size="lg">Continue Shopping</Button>
            </Link>
            <Link href="/account/orders">
              <Button size="lg" variant="outline">View Order Status</Button>
            </Link>
          </div>

          <p className="mt-8 text-sm text-gray-500">
            Questions about your order?{' '}
            <a href="mailto:support@forcemedia.com" className="text-primary hover:underline">
              Contact Support
            </a>
          </p>
        </div>
      </div>
    </main>
  );
}
