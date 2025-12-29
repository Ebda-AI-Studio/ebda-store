import Image from 'next/image';
import Link from 'next/link';

export function Footer() {
  return (
    <footer className="border-t bg-gray-50">
      <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
        <div className="grid gap-8 md:grid-cols-4">
          {/* Brand */}
          <div className="md:col-span-1">
            <Link href="/" className="flex items-center gap-2">
              <Image src="/logo.svg" alt="Force Media" width={32} height={24} />
              <span className="text-lg font-bold">
                <span className="text-primary">Force</span>
                <span className="text-gray-700"> Store</span>
              </span>
            </Link>
            <p className="mt-4 text-sm text-gray-500">
              Modern e-commerce powered by Force Media. Quality products, exceptional service.
            </p>
          </div>

          {/* Shop */}
          <div>
            <h3 className="font-semibold text-gray-900">Shop</h3>
            <ul className="mt-4 space-y-2">
              <li>
                <Link href="/products" className="text-sm text-gray-500 hover:text-primary">
                  All Products
                </Link>
              </li>
              <li>
                <Link href="/products?category=electronics" className="text-sm text-gray-500 hover:text-primary">
                  Electronics
                </Link>
              </li>
              <li>
                <Link href="/products?category=accessories" className="text-sm text-gray-500 hover:text-primary">
                  Accessories
                </Link>
              </li>
              <li>
                <Link href="/products?category=wearables" className="text-sm text-gray-500 hover:text-primary">
                  Wearables
                </Link>
              </li>
            </ul>
          </div>

          {/* Support */}
          <div>
            <h3 className="font-semibold text-gray-900">Support</h3>
            <ul className="mt-4 space-y-2">
              <li>
                <Link href="/contact" className="text-sm text-gray-500 hover:text-primary">
                  Contact Us
                </Link>
              </li>
              <li>
                <Link href="/faq" className="text-sm text-gray-500 hover:text-primary">
                  FAQ
                </Link>
              </li>
              <li>
                <Link href="/shipping" className="text-sm text-gray-500 hover:text-primary">
                  Shipping Info
                </Link>
              </li>
              <li>
                <Link href="/returns" className="text-sm text-gray-500 hover:text-primary">
                  Returns
                </Link>
              </li>
            </ul>
          </div>

          {/* Legal */}
          <div>
            <h3 className="font-semibold text-gray-900">Legal</h3>
            <ul className="mt-4 space-y-2">
              <li>
                <Link href="/privacy" className="text-sm text-gray-500 hover:text-primary">
                  Privacy Policy
                </Link>
              </li>
              <li>
                <Link href="/terms" className="text-sm text-gray-500 hover:text-primary">
                  Terms of Service
                </Link>
              </li>
            </ul>
          </div>
        </div>

        <div className="mt-8 border-t pt-8">
          <p className="text-center text-xs text-gray-500">
            &copy; {new Date().getFullYear()} Force Media. All rights reserved.
          </p>
        </div>
      </div>
    </footer>
  );
}
