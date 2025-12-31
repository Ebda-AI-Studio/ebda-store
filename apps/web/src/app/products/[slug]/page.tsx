'use client';

import { useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { Button, Badge, useToast } from '@force/ui';
import { useCart } from '../../../contexts/CartContext';
import { Header, Footer } from '../../../components';

// Demo product data
const product = {
  id: '1',
  name: 'Premium Wireless Headphones',
  slug: 'premium-wireless-headphones',
  price: 29900,
  compareAtPrice: 34900,
  description:
    'Experience premium sound quality with our wireless headphones. Featuring active noise cancellation, 30-hour battery life, and ultra-comfortable ear cushions for extended listening sessions.',
  features: [
    'Active Noise Cancellation',
    '30-hour battery life',
    'Premium drivers for rich sound',
    'Comfortable memory foam cushions',
    'Bluetooth 5.0 connectivity',
    'Built-in microphone for calls',
  ],
  category: 'Electronics',
  inventory: 50,
  sku: 'HEADPHONES-001',
  images: [
    { url: '/placeholder.svg', alt: 'Headphones front view' },
    { url: '/placeholder.svg', alt: 'Headphones side view' },
    { url: '/placeholder.svg', alt: 'Headphones detail' },
  ],
};

const relatedProducts = [
  {
    id: '2',
    name: 'Smart Watch Pro',
    slug: 'smart-watch-pro',
    price: 39900,
    category: 'Wearables',
  },
  {
    id: '3',
    name: 'Wireless Mechanical Keyboard',
    slug: 'wireless-mechanical-keyboard',
    price: 14900,
    category: 'Accessories',
  },
  {
    id: '4',
    name: 'Portable Bluetooth Speaker',
    slug: 'portable-bluetooth-speaker',
    price: 12900,
    category: 'Electronics',
  },
];

function formatPrice(cents: number) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(cents / 100);
}

export default function ProductDetailPage() {
  const [quantity, setQuantity] = useState(1);
  const [selectedImage, setSelectedImage] = useState(0);
  const [isAdding, setIsAdding] = useState(false);
  const { success } = useToast();
  const { addItem, itemCount } = useCart();

  const handleAddToCart = async () => {
    setIsAdding(true);
    // Simulate API call delay for UX
    await new Promise(resolve => setTimeout(resolve, 300));
    addItem(
      {
        id: product.id,
        name: product.name,
        price: product.price,
        slug: product.slug,
        image: product.images[0]?.url,
        category: product.category,
      },
      quantity
    );
    setIsAdding(false);
    success('Added to cart!', `${quantity}x ${product.name} added to your cart`);
  };

  return (
    <main className="min-h-screen bg-background flex flex-col">
      <Header />

      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8 flex-1">
        {/* Breadcrumb */}
        <nav className="mb-8 flex items-center gap-2 text-sm text-gray-500">
          <Link href="/" className="hover:text-primary">
            Home
          </Link>
          <span>/</span>
          <Link href="/products" className="hover:text-primary">
            Products
          </Link>
          <span>/</span>
          <span className="text-gray-900">{product.name}</span>
        </nav>

        {/* Product Details */}
        <div className="grid gap-8 lg:grid-cols-2">
          {/* Images */}
          <div className="space-y-4">
            <div className="aspect-square overflow-hidden rounded-2xl bg-gradient-to-br from-orange-50 to-orange-100">
              <div className="flex h-full items-center justify-center">
                <div className="mx-auto flex h-40 w-40 items-center justify-center rounded-full bg-primary/20">
                  <svg
                    className="h-20 w-20 text-primary"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1.5}
                      d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
                    />
                  </svg>
                </div>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-4">
              {product.images.map((_, index) => (
                <button
                  key={index}
                  onClick={() => setSelectedImage(index)}
                  className={`aspect-square overflow-hidden rounded-lg bg-gradient-to-br from-orange-50 to-orange-100 transition ${
                    selectedImage === index
                      ? 'ring-2 ring-primary'
                      : 'hover:ring-2 hover:ring-gray-300'
                  }`}
                >
                  <div className="flex h-full items-center justify-center">
                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/20">
                      <svg
                        className="h-5 w-5 text-primary"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={1.5}
                          d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
                        />
                      </svg>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Product Info */}
          <div>
            <div className="mb-4 flex items-center gap-2">
              <Badge variant="secondary">{product.category}</Badge>
              {product.compareAtPrice && (
                <Badge variant="destructive">
                  {Math.round((1 - product.price / product.compareAtPrice) * 100)}% OFF
                </Badge>
              )}
            </div>

            <h1 className="text-3xl font-bold text-gray-900">{product.name}</h1>

            <div className="mt-4 flex items-baseline gap-3">
              <span className="text-3xl font-bold text-primary">{formatPrice(product.price)}</span>
              {product.compareAtPrice && (
                <span className="text-xl text-gray-400 line-through">
                  {formatPrice(product.compareAtPrice)}
                </span>
              )}
            </div>

            <p className="mt-6 text-gray-600 leading-relaxed">{product.description}</p>

            {/* Features */}
            <div className="mt-6">
              <h3 className="font-semibold text-gray-900">Features</h3>
              <ul className="mt-3 space-y-2">
                {product.features.map((feature, index) => (
                  <li key={index} className="flex items-center gap-2 text-sm text-gray-600">
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
                    {feature}
                  </li>
                ))}
              </ul>
            </div>

            {/* Quantity & Add to Cart */}
            <div className="mt-8 space-y-4">
              <div className="flex items-center gap-4">
                <span className="text-sm font-medium text-gray-700">Quantity:</span>
                <div className="flex items-center rounded-lg border">
                  <button
                    onClick={() => setQuantity(Math.max(1, quantity - 1))}
                    className="px-4 py-2 text-gray-600 hover:bg-gray-100"
                  >
                    -
                  </button>
                  <span className="w-12 text-center font-medium">{quantity}</span>
                  <button
                    onClick={() => setQuantity(quantity + 1)}
                    className="px-4 py-2 text-gray-600 hover:bg-gray-100"
                  >
                    +
                  </button>
                </div>
                <span className="text-sm text-gray-500">{product.inventory} in stock</span>
              </div>

              <div className="flex gap-4">
                <Button size="lg" className="flex-1" onClick={handleAddToCart} isLoading={isAdding}>
                  Add to Cart
                </Button>
                <Button size="lg" variant="outline">
                  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z"
                    />
                  </svg>
                </Button>
              </div>
            </div>

            {/* SKU */}
            <div className="mt-6 border-t pt-6">
              <p className="text-sm text-gray-500">SKU: {product.sku}</p>
            </div>
          </div>
        </div>

        {/* Related Products */}
        <div className="mt-16">
          <h2 className="text-2xl font-bold text-gray-900">Related Products</h2>
          <div className="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-3">
            {relatedProducts.map(item => (
              <Link
                key={item.id}
                href={`/products/${item.slug}`}
                className="group rounded-xl border bg-white p-4 shadow-sm transition hover:shadow-lg"
              >
                <div className="aspect-square overflow-hidden rounded-lg bg-gradient-to-br from-orange-50 to-orange-100">
                  <div className="flex h-full items-center justify-center">
                    <div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary/20">
                      <svg
                        className="h-8 w-8 text-primary"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={1.5}
                          d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
                        />
                      </svg>
                    </div>
                  </div>
                </div>
                <div className="mt-4">
                  <p className="text-xs text-gray-500">{item.category}</p>
                  <h3 className="mt-1 font-medium text-gray-900 group-hover:text-primary">
                    {item.name}
                  </h3>
                  <p className="mt-2 font-bold text-primary">{formatPrice(item.price)}</p>
                </div>
              </Link>
            ))}
          </div>
        </div>
      </div>

      <Footer />
    </main>
  );
}
