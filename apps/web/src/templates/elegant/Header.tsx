'use client';

import { useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import type { HeaderProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';
import { LanguageSwitcher } from '../../components/LanguageSwitcher';

export default function ElegantHeader({
  branding,
  navigation = [],
  isRtl: isRtlProp,
  cartItemCount = 0,
  isLoggedIn = false,
  onSearch,
  urlPrefix = '',
}: HeaderProps) {
  const { isRtl: ctxIsRtl } = useLanguage();
  const isRtl = isRtlProp ?? ctxIsRtl;
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearchOpen, setIsSearchOpen] = useState(false);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (onSearch && searchQuery.trim()) {
      onSearch(searchQuery);
      setIsSearchOpen(false);
    }
  };

  const displayName = isRtl && branding.nameAr ? branding.nameAr : branding.name;
  const displayLogo = isRtl && branding.logoAr ? branding.logoAr : branding.logo;

  return (
    <header className="bg-background border-b border-border" dir={isRtl ? 'rtl' : 'ltr'}>
      <div className="container mx-auto px-4">
        {/* Top utility bar — Contact + Wishlist only. The shipping promo
            line was a hardcoded demo; tenants who want a promo line should
            configure the AnnouncementBar (rendered above the header). */}
        <div className="hidden md:flex items-center justify-end gap-6 py-2 text-xs tracking-[0.15em] uppercase text-muted-foreground border-b border-border/50">
          <Link
            href={`${urlPrefix}/contact`}
            className="hover:text-foreground transition-colors duration-500 ease-out cursor-pointer"
          >
            {isRtl ? 'تواصل معنا' : 'Contact'}
          </Link>
          <Link
            href={`${urlPrefix}/wishlist`}
            className="hover:text-foreground transition-colors duration-500 ease-out cursor-pointer"
          >
            {isRtl ? 'المفضلة' : 'Wishlist'}
          </Link>
        </div>

        {/* Main header row */}
        <div className="flex items-center justify-between py-6 gap-6">
          {/* Mobile menu trigger */}
          <button
            type="button"
            onClick={() => setIsMenuOpen(!isMenuOpen)}
            className="md:hidden inline-flex h-11 w-11 items-center justify-center text-foreground/60 hover:text-foreground transition-colors duration-500 ease-out cursor-pointer"
            aria-label={isRtl ? 'القائمة' : 'Menu'}
            aria-expanded={isMenuOpen}
          >
            <svg
              className="w-6 h-6"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              strokeWidth={1}
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d={isMenuOpen ? 'M6 18L18 6M6 6l12 12' : 'M4 6h16M4 12h16M4 18h16'}
              />
            </svg>
          </button>

          {/* Spacer for logo centering on desktop */}
          <div className="hidden md:flex flex-1" />

          {/* Logo — center */}
          <Link href={urlPrefix || '/'} className="flex-shrink-0 cursor-pointer">
            {displayLogo ? (
              <Image
                src={displayLogo}
                alt={displayName}
                width={320}
                height={120}
                className="h-20 max-h-20 w-auto sm:h-24 sm:max-h-24"
                priority
              />
            ) : (
              <span className="text-3xl font-light tracking-[0.25em] text-foreground">
                {displayName}
              </span>
            )}
          </Link>

          {/* Actions — right */}
          <div className="flex items-center gap-2 flex-1 justify-end">
            {/* Search */}
            <button
              type="button"
              onClick={() => setIsSearchOpen(!isSearchOpen)}
              className="hidden md:inline-flex h-11 w-11 items-center justify-center text-foreground/50 hover:text-foreground transition-colors duration-500 ease-out cursor-pointer"
              aria-label={isRtl ? 'بحث' : 'Search'}
            >
              <svg
                className="w-5 h-5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                strokeWidth={1}
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                />
              </svg>
            </button>

            {/* Language toggle — visible on every breakpoint so customers
                can switch even when the rest of the actions row collapses. */}
            <LanguageSwitcher
              variant="compact"
              className="text-foreground/60 hover:text-foreground"
            />

            {/* Account */}
            <Link
              href={isLoggedIn ? `${urlPrefix}/account` : `${urlPrefix}/auth/login`}
              className="hidden md:inline-flex h-11 w-11 items-center justify-center text-foreground/50 hover:text-foreground transition-colors duration-500 ease-out cursor-pointer"
              aria-label={isRtl ? 'الحساب' : 'Account'}
            >
              <svg
                className="w-5 h-5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                strokeWidth={1}
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
                />
              </svg>
            </Link>

            {/* Cart */}
            <Link
              href={`${urlPrefix}/cart`}
              className="relative inline-flex h-11 w-11 items-center justify-center text-foreground/50 hover:text-foreground transition-colors duration-500 ease-out cursor-pointer"
              aria-label={isRtl ? `السلة (${cartItemCount})` : `Cart (${cartItemCount})`}
            >
              <svg
                className="w-5 h-5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                strokeWidth={1}
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z"
                />
              </svg>
              {cartItemCount > 0 && (
                <span
                  className={`absolute -top-2 ${isRtl ? '-left-2' : '-right-2'} bg-foreground text-background text-[9px] font-medium w-4 h-4 rounded-full flex items-center justify-center`}
                >
                  {cartItemCount > 9 ? '9+' : cartItemCount}
                </span>
              )}
            </Link>
          </div>
        </div>

        {/* Desktop navigation — below logo */}
        <nav className="hidden md:flex items-center justify-center gap-10 pb-5">
          {navigation.map(item => (
            <Link
              key={item.href}
              href={item.href}
              className="text-sm tracking-[0.18em] uppercase text-muted-foreground hover:text-foreground transition-colors duration-500 ease-out cursor-pointer"
            >
              {isRtl && item.labelAr ? item.labelAr : item.label}
            </Link>
          ))}
        </nav>

        {/* Search field — expands below nav */}
        <div
          className={`overflow-hidden transition-all duration-500 ${isSearchOpen ? 'max-h-24 opacity-100 py-6 border-t border-border/50' : 'max-h-0 opacity-0 py-0'}`}
        >
          <form onSubmit={handleSearch} className="max-w-lg mx-auto">
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder={isRtl ? 'ما الذي تبحث عنه؟' : 'What are you looking for?'}
              className="w-full px-0 py-3 bg-transparent border-0 border-b border-border focus:outline-none focus:border-foreground text-center text-sm tracking-[0.1em] placeholder:text-muted-foreground/50 transition-colors duration-500"
              dir={isRtl ? 'rtl' : 'ltr'}
              autoFocus={isSearchOpen}
              aria-label={isRtl ? 'بحث عن المنتجات' : 'Search products'}
            />
          </form>
        </div>

        {/* Mobile menu */}
        {isMenuOpen && (
          <nav className="md:hidden py-6 border-t border-border/50">
            <ul className="space-y-5 text-center">
              {navigation.map(item => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className="text-sm tracking-[0.18em] uppercase text-muted-foreground hover:text-foreground transition-colors duration-500 ease-out cursor-pointer"
                    onClick={() => setIsMenuOpen(false)}
                  >
                    {isRtl && item.labelAr ? item.labelAr : item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        )}
      </div>
    </header>
  );
}
