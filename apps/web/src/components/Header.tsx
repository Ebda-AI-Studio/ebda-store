'use client';

import {
  useState,
  useEffect,
  useRef,
  useCallback,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { useRouter, usePathname } from 'next/navigation';
import { Button } from '@force/ui';
import { useLanguage, translations } from '../contexts/LanguageContext';
import { useCart } from '../contexts/CartContext';
import { useStore, useStoreUrl } from '../contexts/StoreContext';
import { LanguageSwitcher } from './LanguageSwitcher';
import { SearchAutocomplete } from './SearchAutocomplete';
import { useFeatures } from '../contexts/FeatureContext';

interface HeaderProps {
  cartCount?: number;
}

export function Header({ cartCount: cartCountProp }: HeaderProps) {
  const router = useRouter();
  const pathname = usePathname();
  const { store } = useStore();
  const { itemCount } = useCart();
  const cartCount = cartCountProp ?? itemCount;
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const { t } = useLanguage();
  const storeUrl = useStoreUrl();
  const { isEnabled } = useFeatures();
  const autocompleteEnabled = isEnabled('search_autocomplete');
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const mobileMenuRef = useRef<HTMLDivElement>(null);

  // UX-007: Close mobile menu on route change
  useEffect(() => {
    setIsMobileMenuOpen(false);
  }, [pathname]);

  // A11Y-001/A11Y-002: Escape key closes mobile menu and auto-focus close button
  const handleMobileMenuEscape = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      setIsMobileMenuOpen(false);
    }
  }, []);

  useEffect(() => {
    if (!isMobileMenuOpen) return;
    document.addEventListener('keydown', handleMobileMenuEscape);
    closeButtonRef.current?.focus();
    return () => document.removeEventListener('keydown', handleMobileMenuEscape);
  }, [isMobileMenuOpen, handleMobileMenuEscape]);

  // A11Y-002: Focus trap within mobile menu
  const handleMobileMenuKeyDown = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      setIsMobileMenuOpen(false);
      return;
    }
    if (e.key !== 'Tab' || !mobileMenuRef.current) return;

    const focusableElements = mobileMenuRef.current.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    if (focusableElements.length === 0) return;

    const first = focusableElements[0];
    const last = focusableElements[focusableElements.length - 1];

    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }, []);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const q = searchQuery.trim();
    if (q) {
      router.push(storeUrl(`/search?q=${encodeURIComponent(q)}`));
      setSearchQuery('');
      setIsSearchOpen(false);
      setIsMobileMenuOpen(false);
    }
  };

  const navigation = [
    { name: t('Products', translations['Products']), href: storeUrl('/products') },
    { name: t('Categories', translations['Categories']), href: storeUrl('/categories') },
    { name: t('About', translations['About']), href: storeUrl('/about') },
    { name: t('Contact', translations['Contact']), href: storeUrl('/contact') },
  ];

  return (
    <>
      <nav
        className="sticky top-0 z-50 border-b border-border/50 bg-background/95 backdrop-blur-lg"
        aria-label={t('Main navigation', 'التنقل الرئيسي')}
      >
        {/* Top Bar - Optional Announcement */}
        <div className="hidden bg-primary text-center text-xs text-white sm:block">
          <div className="mx-auto max-w-7xl px-4 py-2">
            <span className="font-medium">
              {t(
                'Free delivery on orders over 20 KWD',
                translations['Free delivery on orders over 20 KWD']
              )}
            </span>
            <span className="mx-2">•</span>
            <span>
              {t(
                'Same-day delivery across Kuwait',
                translations['Same-day delivery across Kuwait']
              )}
            </span>
          </div>
        </div>

        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="flex h-16 items-center justify-between gap-4 lg:h-20">
            {/* Mobile Menu Button */}
            <button
              onClick={() => setIsMobileMenuOpen(true)}
              className="flex h-10 w-10 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-muted hover:text-foreground lg:hidden"
              aria-label={t('Open menu', 'فتح القائمة')}
            >
              <svg
                className="h-6 w-6"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 6h16M4 12h16M4 18h16"
                />
              </svg>
              <span className="sr-only">{t('Open menu', 'فتح القائمة')}</span>
            </button>

            {/* Logo */}
            <Link href={storeUrl('/')} className="flex items-center gap-3">
              {store.logo ? (
                <Image
                  src={store.logo}
                  alt={store.name}
                  width={120}
                  height={56}
                  className="h-14 max-h-14 w-auto object-contain"
                />
              ) : (
                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary text-xl font-bold text-primary-foreground">
                  {store.name?.charAt(0) || 'S'}
                </div>
              )}
            </Link>
            <Link href={storeUrl('/')} className="hidden sm:block">
              <span className="text-xl font-bold tracking-tight text-foreground">{store.name}</span>
            </Link>

            {/* Desktop Navigation */}
            <div className="hidden items-center gap-1 lg:flex">
              {navigation.map(item => (
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
              <div className="relative">
                <form onSubmit={handleSearch} role="search" className="search-box">
                  <svg
                    className="h-5 w-5 text-muted-foreground"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                    />
                  </svg>
                  <input
                    type="text"
                    placeholder={t('Search products...', 'ابحث عن المنتجات...')}
                    className="search-input"
                    aria-label={t('Search products', 'ابحث عن المنتجات')}
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                  />
                  <kbd className="hidden rounded bg-muted px-2 py-1 text-xs font-medium text-muted-foreground sm:block">
                    ⌘K
                  </kbd>
                </form>
                {autocompleteEnabled && (
                  <SearchAutocomplete
                    query={searchQuery}
                    onSelect={() => {
                      setSearchQuery('');
                      setIsSearchOpen(false);
                    }}
                  />
                )}
              </div>
            </div>

            {/* Right Actions */}
            <div className="flex items-center gap-2 sm:gap-3">
              {/* Language Switcher */}
              <LanguageSwitcher variant="compact" />

              {/* Search Button - Mobile */}
              <button
                onClick={() => setIsSearchOpen(true)}
                className="flex h-10 w-10 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-muted hover:text-foreground lg:hidden"
                aria-label={t('Search', translations['Search'])}
              >
                <svg
                  className="h-5 w-5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                  />
                </svg>
                <span className="sr-only">{t('Search', translations['Search'])}</span>
              </button>

              {/* Wishlist */}
              <Link
                href={storeUrl('/wishlist')}
                className="hidden h-10 w-10 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-muted hover:text-foreground sm:flex"
                aria-label={t('Wishlist', translations['Wishlist'])}
              >
                <svg
                  className="h-5 w-5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z"
                  />
                </svg>
                <span className="sr-only">{t('Wishlist', translations['Wishlist'])}</span>
              </Link>

              {/* Cart */}
              <Link
                href={storeUrl('/cart')}
                className="relative flex h-10 w-10 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                aria-label={`${t('Cart', translations['Cart'])} ${cartCount}`}
              >
                <svg
                  className="h-5 w-5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z"
                  />
                </svg>
                <span className="sr-only">{`${t('Cart', translations['Cart'])} ${cartCount}`}</span>
                <span aria-live="polite" className="absolute -end-1 -top-1">
                  {cartCount > 0 && (
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-white shadow-lg shadow-primary/25">
                      {cartCount > 99 ? '99+' : cartCount}
                    </span>
                  )}
                </span>
              </Link>

              {/* User Account / Sign In */}
              <Link href={storeUrl('/auth/login')} className="hidden sm:block">
                <Button size="sm" className="gap-2 rounded-xl shadow-md shadow-primary/20">
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
                    />
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
          role="presentation"
          onClick={() => setIsMobileMenuOpen(false)}
          onKeyDown={e => {
            if (e.key === 'Escape') setIsMobileMenuOpen(false);
          }}
        />
      )}

      {/* Mobile Menu */}
      <div
        ref={mobileMenuRef}
        className={`fixed inset-y-0 start-0 z-50 w-80 max-w-[85vw] transform bg-background shadow-2xl transition-transform duration-300 ease-out lg:hidden ${
          isMobileMenuOpen ? 'translate-x-0' : 'ltr:-translate-x-full rtl:translate-x-full'
        }`}
        onKeyDown={handleMobileMenuKeyDown}
      >
        <div className="flex h-full flex-col">
          {/* Menu Header */}
          <div className="flex items-center justify-between border-b px-4 py-4">
            <Link
              href={storeUrl('/')}
              className="flex items-center gap-2"
              onClick={() => setIsMobileMenuOpen(false)}
            >
              {store.logo ? (
                <Image
                  src={store.logo}
                  alt={store.name}
                  width={80}
                  height={36}
                  className="h-9 max-h-9 w-auto object-contain"
                />
              ) : (
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary text-base font-bold text-primary-foreground">
                  {store.name?.charAt(0) || 'S'}
                </div>
              )}
              <span className="text-lg font-bold text-foreground">{store.name}</span>
            </Link>
            <button
              ref={closeButtonRef}
              onClick={() => setIsMobileMenuOpen(false)}
              className="flex h-10 w-10 items-center justify-center rounded-xl text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label={t('Close menu', 'إغلاق القائمة')}
            >
              <svg
                className="h-5 w-5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
              <span className="sr-only">{t('Close menu', 'إغلاق القائمة')}</span>
            </button>
          </div>

          {/* Search */}
          <div className="border-b px-4 py-4">
            <form onSubmit={handleSearch} role="search" className="search-box">
              <svg
                className="h-5 w-5 text-muted-foreground"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                />
              </svg>
              <input
                type="text"
                placeholder={t('Search products...', 'ابحث عن المنتجات...')}
                className="search-input"
                aria-label={t('Search products', 'ابحث عن المنتجات')}
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
              />
            </form>
          </div>

          {/* Navigation */}
          <nav
            className="flex-1 overflow-y-auto px-4 py-4"
            aria-label={t('Mobile navigation', 'تنقل الجوال')}
          >
            <ul className="space-y-1">
              {navigation.map(item => (
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
                  href={storeUrl('/wishlist')}
                  className="flex items-center gap-3 rounded-xl px-4 py-3 text-base font-medium text-foreground transition-colors hover:bg-muted"
                  onClick={() => setIsMobileMenuOpen(false)}
                >
                  <svg
                    className="h-5 w-5 text-muted-foreground"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1.5}
                      d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z"
                    />
                  </svg>
                  {t('Wishlist', translations['Wishlist'])}
                </Link>
              </li>
              <li>
                <Link
                  href={storeUrl('/account')}
                  className="flex items-center gap-3 rounded-xl px-4 py-3 text-base font-medium text-foreground transition-colors hover:bg-muted"
                  onClick={() => setIsMobileMenuOpen(false)}
                >
                  <svg
                    className="h-5 w-5 text-muted-foreground"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1.5}
                      d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
                    />
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
            <Link
              href={storeUrl('/auth/login')}
              className="block"
              onClick={() => setIsMobileMenuOpen(false)}
            >
              <Button className="w-full" size="lg">
                {t('Sign In', translations['Sign In'])}
              </Button>
            </Link>
            <Link
              href={storeUrl('/auth/register')}
              className="block"
              onClick={() => setIsMobileMenuOpen(false)}
            >
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
          <div className="fixed inset-x-0 top-0 z-50 bg-background p-4 shadow-lg lg:hidden animate-slide-down">
            <div className="flex items-center gap-3">
              <div className="relative flex-1">
                <form onSubmit={handleSearch} role="search" className="search-box">
                  <svg
                    className="h-5 w-5 text-muted-foreground"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                    />
                  </svg>
                  <input
                    type="text"
                    placeholder={t('Search products...', 'ابحث عن المنتجات...')}
                    className="search-input"
                    aria-label={t('Search products', 'ابحث عن المنتجات')}
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    autoFocus
                  />
                </form>
                {autocompleteEnabled && (
                  <SearchAutocomplete
                    query={searchQuery}
                    onSelect={() => {
                      setSearchQuery('');
                      setIsSearchOpen(false);
                    }}
                  />
                )}
              </div>
              <button
                onClick={() => setIsSearchOpen(false)}
                className="flex h-10 w-10 items-center justify-center rounded-xl text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label={t('Close search', 'إغلاق البحث')}
              >
                <svg
                  className="h-5 w-5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
                <span className="sr-only">{t('Close search', 'إغلاق البحث')}</span>
              </button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
