'use client';

import { useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { Button } from '@force/ui';
import { useLanguage, translations } from '../contexts/LanguageContext';
import { useCart } from '../contexts/CartContext';
import { LanguageSwitcher } from './LanguageSwitcher';

interface HeaderProps {
  cartCount?: number;
}

export function Header({ cartCount: cartCountProp }: HeaderProps) {
  const { itemCount } = useCart();
  const cartCount = cartCountProp ?? itemCount;
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const { t } = useLanguage();

  const navigation = [
    { name: t('Products', translations['Products']), href: '/products' },
    { name: t('Categories', translations['Categories']), href: '/categories' },
    { name: t('About', translations['About']), href: '/about' },
    { name: t('Contact', translations['Contact']), href: '/contact' },
  ];

  return (
    <>
      <nav className="sticky top-0 z-50 border-b border-border/50 bg-white/95 backdrop-blur-lg">
        {/* Top Bar - Optional Announcement */}
        <div className="hidden bg-primary text-center text-xs text-white sm:block">
          <div className="mx-auto max-w-7xl px-4 py-2">
            <span className="font-medium">{t('Free delivery on orders over 20 KWD', translations['Free delivery on orders over 20 KWD'])}</span>
            <span className="mx-2">•</span>
            <span>{t('Same-day delivery across Kuwait', translations['Same-day delivery across Kuwait'])}</span>
          </div>
        </div>

        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="flex h-16 items-center justify-between gap-4 lg:h-20">
            {/* Mobile Menu Button */}
            <button
              onClick={() => setIsMobileMenuOpen(true)}
              className="flex h-10 w-10 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-muted hover:text-foreground lg:hidden"
              aria-label="Open menu"
            >
              <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>

            {/* Logo */}
            <Link href="/" className="flex items-center gap-2">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-orange-600 shadow-lg shadow-primary/25">
                <Image src="/logo.svg" alt="Force Media" width={24} height={18} className="brightness-0 invert" />
              </div>
              <span className="hidden text-xl font-bold tracking-tight sm:block">
                <span className="text-primary">Force</span>
                <span className="text-foreground"> Store</span>
              </span>
            </Link>

            {/* Desktop Navigation */}
            <div className="hidden items-center gap-1 lg:flex">
              {navigation.map((item) => (
                <Link
                  key={item.name}
                  href={item.href}
                  className="rounded-xl px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  {item.name}
                </Link>
              ))}
            </div>

            {/* Search Bar - Desktop */}
            <div className="hidden flex-1 max-w-md lg:block">
              <div className="search-box">
                <svg className="h-5 w-5 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                <input
                  type="text"
                  placeholder="Search products..."
                  className="search-input"
                />
                <kbd className="hidden rounded bg-muted px-2 py-1 text-xs font-medium text-muted-foreground sm:block">
                  ⌘K
                </kbd>
              </div>
            </div>

            {/* Right Actions */}
            <div className="flex items-center gap-2 sm:gap-3">
              {/* Language Switcher - Desktop */}
              <LanguageSwitcher variant="compact" className="hidden sm:flex" />

              {/* Search Button - Mobile */}
              <button
                onClick={() => setIsSearchOpen(true)}
                className="flex h-10 w-10 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-muted hover:text-foreground lg:hidden"
                aria-label={t('Search', translations['Search'])}
              >
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              </button>

              {/* Wishlist */}
              <Link
                href="/wishlist"
                className="hidden h-10 w-10 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-muted hover:text-foreground sm:flex"
                aria-label={t('Wishlist', translations['Wishlist'])}
              >
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
                </svg>
              </Link>

              {/* Cart */}
              <Link
                href="/cart"
                className="relative flex h-10 w-10 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                aria-label={`${t('Cart', translations['Cart'])} ${cartCount}`}
              >
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z" />
                </svg>
                {cartCount > 0 && (
                  <span className="absolute -end-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-white shadow-lg shadow-primary/25">
                    {cartCount > 99 ? '99+' : cartCount}
                  </span>
                )}
              </Link>

              {/* User Account / Sign In */}
              <Link href="/auth/login" className="hidden sm:block">
                <Button size="sm" className="gap-2 rounded-xl shadow-md shadow-primary/20">
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                  </svg>
                  {t('Sign In', translations['Sign In'])}
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </nav>

      {/* Mobile Menu Overlay */}
      {isMobileMenuOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm lg:hidden animate-fade-in"
          onClick={() => setIsMobileMenuOpen(false)}
        />
      )}

      {/* Mobile Menu */}
      <div
        className={`fixed inset-y-0 left-0 z-50 w-80 max-w-[85vw] transform bg-white shadow-2xl transition-transform duration-300 ease-out lg:hidden ${
          isMobileMenuOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex h-full flex-col">
          {/* Menu Header */}
          <div className="flex items-center justify-between border-b px-4 py-4">
            <Link href="/" className="flex items-center gap-2" onClick={() => setIsMobileMenuOpen(false)}>
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-orange-600">
                <Image src="/logo.svg" alt="Force Media" width={20} height={15} className="brightness-0 invert" />
              </div>
              <span className="text-lg font-bold">
                <span className="text-primary">Force</span>
                <span className="text-foreground"> Store</span>
              </span>
            </Link>
            <button
              onClick={() => setIsMobileMenuOpen(false)}
              className="flex h-10 w-10 items-center justify-center rounded-xl text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label="Close menu"
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Search */}
          <div className="border-b px-4 py-4">
            <div className="search-box">
              <svg className="h-5 w-5 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input type="text" placeholder="Search products..." className="search-input" />
            </div>
          </div>

          {/* Navigation */}
          <nav className="flex-1 overflow-y-auto px-4 py-4">
            <ul className="space-y-1">
              {navigation.map((item) => (
                <li key={item.name}>
                  <Link
                    href={item.href}
                    className="flex items-center gap-3 rounded-xl px-4 py-3 text-base font-medium text-foreground transition-colors hover:bg-muted"
                    onClick={() => setIsMobileMenuOpen(false)}
                  >
                    {item.name}
                  </Link>
                </li>
              ))}
              <li className="border-t pt-2 mt-2">
                <Link
                  href="/wishlist"
                  className="flex items-center gap-3 rounded-xl px-4 py-3 text-base font-medium text-foreground transition-colors hover:bg-muted"
                  onClick={() => setIsMobileMenuOpen(false)}
                >
                  <svg className="h-5 w-5 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
                  </svg>
                  {t('Wishlist', translations['Wishlist'])}
                </Link>
              </li>
              <li>
                <Link
                  href="/account"
                  className="flex items-center gap-3 rounded-xl px-4 py-3 text-base font-medium text-foreground transition-colors hover:bg-muted"
                  onClick={() => setIsMobileMenuOpen(false)}
                >
                  <svg className="h-5 w-5 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                  </svg>
                  {t('My Account', translations['My Account'])}
                </Link>
              </li>
            </ul>
          </nav>

          {/* Language Switcher - Mobile */}
          <div className="border-t px-4 py-3">
            <LanguageSwitcher />
          </div>

          {/* Auth Buttons */}
          <div className="border-t p-4 space-y-3">
            <Link href="/auth/login" className="block" onClick={() => setIsMobileMenuOpen(false)}>
              <Button className="w-full" size="lg">
                {t('Sign In', translations['Sign In'])}
              </Button>
            </Link>
            <Link href="/auth/register" className="block" onClick={() => setIsMobileMenuOpen(false)}>
              <Button variant="outline" className="w-full" size="lg">
                {t('Create Account', translations['Create Account'])}
              </Button>
            </Link>
          </div>
        </div>
      </div>

      {/* Mobile Search Overlay */}
      {isSearchOpen && (
        <>
          <div
            className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm lg:hidden animate-fade-in"
            onClick={() => setIsSearchOpen(false)}
          />
          <div className="fixed inset-x-0 top-0 z-50 bg-white p-4 shadow-lg lg:hidden animate-slide-down">
            <div className="flex items-center gap-3">
              <div className="search-box flex-1">
                <svg className="h-5 w-5 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                <input
                  type="text"
                  placeholder="Search products..."
                  className="search-input"
                  autoFocus
                />
              </div>
              <button
                onClick={() => setIsSearchOpen(false)}
                className="flex h-10 w-10 items-center justify-center rounded-xl text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label="Close search"
              >
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
