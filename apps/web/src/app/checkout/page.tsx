'use client';

import { useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { Button, Input, Select } from '@force/ui';

// Demo cart data
const cartItems = [
  { id: '1', name: 'Premium Wireless Headphones', price: 29900, quantity: 1 },
  { id: '2', name: 'Wireless Mechanical Keyboard', price: 14900, quantity: 2 },
];

function formatPrice(cents: number) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(cents / 100);
}

const countries = [
  { value: 'US', label: 'United States' },
  { value: 'CA', label: 'Canada' },
  { value: 'UK', label: 'United Kingdom' },
  { value: 'AU', label: 'Australia' },
  { value: 'KW', label: 'Kuwait' },
  { value: 'AE', label: 'United Arab Emirates' },
  { value: 'SA', label: 'Saudi Arabia' },
];

export default function CheckoutPage() {
  const [step, setStep] = useState(1);
  const [isProcessing, setIsProcessing] = useState(false);
  const [formData, setFormData] = useState({
    // Shipping
    email: '',
    firstName: '',
    lastName: '',
    address: '',
    apartment: '',
    city: '',
    country: 'US',
    state: '',
    zipCode: '',
    phone: '',
    // Payment
    cardNumber: '',
    cardName: '',
    expiryDate: '',
    cvv: '',
  });

  const updateField = (field: string, value: string) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  const subtotal = cartItems.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const shipping = 0;
  const tax = Math.round(subtotal * 0.1);
  const total = subtotal + shipping + tax;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (step === 1) {
      setStep(2);
    } else {
      setIsProcessing(true);
      // Simulate payment processing
      await new Promise(resolve => setTimeout(resolve, 2000));
      setIsProcessing(false);
      // Redirect to success page
      window.location.href = '/checkout/success';
    }
  };

  return (
    <main className="min-h-screen bg-gray-50">
      {/* Navigation */}
      <nav className="border-b bg-white">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
          <Link href="/" className="flex items-center gap-2">
            <Image src="/logo.svg" alt="Force Media" width={40} height={30} />
            <span className="text-xl font-bold">
              <span className="text-primary">Force</span>
              <span className="text-gray-700"> Store</span>
            </span>
          </Link>
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
            Secure Checkout
          </div>
        </div>
      </nav>

      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        {/* Progress Steps */}
        <div className="mb-8">
          <div className="flex items-center justify-center">
            <div className="flex items-center">
              <div className={`flex h-8 w-8 items-center justify-center rounded-full ${step >= 1 ? 'bg-primary text-white' : 'bg-gray-200 text-gray-600'}`}>
                1
              </div>
              <span className={`ml-2 text-sm font-medium ${step >= 1 ? 'text-gray-900' : 'text-gray-500'}`}>
                Shipping
              </span>
            </div>
            <div className={`mx-4 h-0.5 w-16 ${step >= 2 ? 'bg-primary' : 'bg-gray-200'}`} />
            <div className="flex items-center">
              <div className={`flex h-8 w-8 items-center justify-center rounded-full ${step >= 2 ? 'bg-primary text-white' : 'bg-gray-200 text-gray-600'}`}>
                2
              </div>
              <span className={`ml-2 text-sm font-medium ${step >= 2 ? 'text-gray-900' : 'text-gray-500'}`}>
                Payment
              </span>
            </div>
          </div>
        </div>

        <div className="lg:grid lg:grid-cols-12 lg:gap-8">
          {/* Form */}
          <div className="lg:col-span-7">
            <form onSubmit={handleSubmit}>
              {step === 1 && (
                <div className="rounded-xl border bg-white p-6 shadow-sm">
                  <h2 className="text-lg font-semibold text-gray-900">Shipping Information</h2>

                  <div className="mt-6 space-y-4">
                    <Input
                      label="Email address"
                      type="email"
                      value={formData.email}
                      onChange={e => updateField('email', e.target.value)}
                      required
                    />

                    <div className="grid grid-cols-2 gap-4">
                      <Input
                        label="First name"
                        value={formData.firstName}
                        onChange={e => updateField('firstName', e.target.value)}
                        required
                      />
                      <Input
                        label="Last name"
                        value={formData.lastName}
                        onChange={e => updateField('lastName', e.target.value)}
                        required
                      />
                    </div>

                    <Input
                      label="Address"
                      value={formData.address}
                      onChange={e => updateField('address', e.target.value)}
                      required
                    />

                    <Input
                      label="Apartment, suite, etc. (optional)"
                      value={formData.apartment}
                      onChange={e => updateField('apartment', e.target.value)}
                    />

                    <div className="grid grid-cols-2 gap-4">
                      <Input
                        label="City"
                        value={formData.city}
                        onChange={e => updateField('city', e.target.value)}
                        required
                      />
                      <Select
                        label="Country"
                        value={formData.country}
                        onChange={e => updateField('country', e.target.value)}
                        options={countries}
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <Input
                        label="State / Province"
                        value={formData.state}
                        onChange={e => updateField('state', e.target.value)}
                        required
                      />
                      <Input
                        label="ZIP / Postal code"
                        value={formData.zipCode}
                        onChange={e => updateField('zipCode', e.target.value)}
                        required
                      />
                    </div>

                    <Input
                      label="Phone"
                      type="tel"
                      value={formData.phone}
                      onChange={e => updateField('phone', e.target.value)}
                      required
                    />
                  </div>

                  <div className="mt-6 flex justify-between">
                    <Link href="/cart" className="text-sm text-primary hover:underline">
                      &larr; Return to cart
                    </Link>
                    <Button type="submit">
                      Continue to Payment
                    </Button>
                  </div>
                </div>
              )}

              {step === 2 && (
                <div className="space-y-6">
                  {/* Shipping Summary */}
                  <div className="rounded-xl border bg-white p-6 shadow-sm">
                    <div className="flex items-center justify-between">
                      <h3 className="font-medium text-gray-900">Shipping to</h3>
                      <button
                        type="button"
                        onClick={() => setStep(1)}
                        className="text-sm text-primary hover:underline"
                      >
                        Edit
                      </button>
                    </div>
                    <p className="mt-2 text-sm text-gray-600">
                      {formData.firstName} {formData.lastName}<br />
                      {formData.address}{formData.apartment && `, ${formData.apartment}`}<br />
                      {formData.city}, {formData.state} {formData.zipCode}<br />
                      {formData.email}
                    </p>
                  </div>

                  {/* Payment Form */}
                  <div className="rounded-xl border bg-white p-6 shadow-sm">
                    <h2 className="text-lg font-semibold text-gray-900">Payment Information</h2>
                    <p className="mt-1 text-sm text-gray-500">All transactions are secure and encrypted.</p>

                    <div className="mt-6 space-y-4">
                      <Input
                        label="Card number"
                        placeholder="1234 5678 9012 3456"
                        value={formData.cardNumber}
                        onChange={e => updateField('cardNumber', e.target.value)}
                        required
                      />

                      <Input
                        label="Name on card"
                        value={formData.cardName}
                        onChange={e => updateField('cardName', e.target.value)}
                        required
                      />

                      <div className="grid grid-cols-2 gap-4">
                        <Input
                          label="Expiry date"
                          placeholder="MM/YY"
                          value={formData.expiryDate}
                          onChange={e => updateField('expiryDate', e.target.value)}
                          required
                        />
                        <Input
                          label="Security code (CVV)"
                          placeholder="123"
                          value={formData.cvv}
                          onChange={e => updateField('cvv', e.target.value)}
                          required
                        />
                      </div>
                    </div>

                    <div className="mt-6 flex items-center gap-4">
                      <Image src="/stripe.svg" alt="Stripe" width={60} height={25} className="opacity-50" />
                      <span className="text-xs text-gray-400">Payments powered by Stripe</span>
                    </div>
                  </div>

                  <div className="flex justify-between">
                    <button
                      type="button"
                      onClick={() => setStep(1)}
                      className="text-sm text-primary hover:underline"
                    >
                      &larr; Return to shipping
                    </button>
                    <Button type="submit" size="lg" isLoading={isProcessing}>
                      {isProcessing ? 'Processing...' : `Pay ${formatPrice(total)}`}
                    </Button>
                  </div>
                </div>
              )}
            </form>
          </div>

          {/* Order Summary */}
          <div className="mt-8 lg:col-span-5 lg:mt-0">
            <div className="sticky top-24 rounded-xl border bg-white p-6 shadow-sm">
              <h2 className="text-lg font-semibold text-gray-900">Order Summary</h2>

              <div className="mt-6 divide-y">
                {cartItems.map(item => (
                  <div key={item.id} className="flex gap-4 py-4 first:pt-0">
                    <div className="relative h-16 w-16 flex-shrink-0 overflow-hidden rounded-lg bg-gradient-to-br from-orange-50 to-orange-100">
                      <div className="flex h-full items-center justify-center">
                        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/20">
                          <svg className="h-4 w-4 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
                          </svg>
                        </div>
                      </div>
                      <span className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-gray-500 text-xs text-white">
                        {item.quantity}
                      </span>
                    </div>
                    <div className="flex flex-1 flex-col">
                      <h3 className="text-sm font-medium text-gray-900">{item.name}</h3>
                      <p className="mt-auto text-sm font-medium text-gray-600">
                        {formatPrice(item.price * item.quantity)}
                      </p>
                    </div>
                  </div>
                ))}
              </div>

              <div className="mt-6 space-y-3 border-t pt-6">
                <div className="flex justify-between text-sm">
                  <span className="text-gray-600">Subtotal</span>
                  <span className="font-medium">{formatPrice(subtotal)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-600">Shipping</span>
                  <span className="font-medium text-green-600">Free</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-600">Tax (10%)</span>
                  <span className="font-medium">{formatPrice(tax)}</span>
                </div>
                <div className="flex justify-between border-t pt-3">
                  <span className="text-lg font-semibold text-gray-900">Total</span>
                  <span className="text-lg font-bold text-primary">{formatPrice(total)}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
