'use client';

import Link from 'next/link';
import { useLanguage } from '@/contexts/LanguageContext';
import { BRAND } from '@ebda/shared';

export function LandingHeader() {
  const { language, setLanguage, t } = useLanguage();

  const navLinks = [
    { label: t('What we do', 'ماذا نقدم'), href: '#features' },
    { label: t('Contact', 'تواصل'), href: `mailto:${BRAND.supportEmail}` },
  ];

  return (
    <header className="sticky top-0 z-50 bg-[#0b0a09]/72 backdrop-blur-md border-b border-white/10">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-6">
        {/* Logo + wordmark */}
        <Link href="/" className="flex items-center gap-2.5 shrink-0">
          <img
            src={language === 'ar' ? '/lockup-ar-dark.svg' : '/lockup-dark.svg'}
            alt={language === 'ar' ? BRAND.product.nameAr : BRAND.product.nameEn}
            className="h-10 w-auto"
            width={71}
            height={40}
          />
        </Link>

        {/* Desktop nav — hidden on mobile */}
        <nav className="hidden md:flex items-center gap-8 flex-1 justify-center">
          {navLinks.map(link => (
            <a
              key={link.href}
              href={link.href}
              className="text-sm text-white/60 hover:text-white transition-colors"
            >
              {link.label}
            </a>
          ))}
        </nav>

        {/* Language toggle + CTA — always visible */}
        <div className="shrink-0 flex items-center gap-3">
          {/* Language toggle */}
          <button
            type="button"
            onClick={() => setLanguage(language === 'ar' ? 'en' : 'ar')}
            className="rounded-full border border-white/20 px-3 py-1.5 text-sm text-white/80 hover:text-white transition-colors"
          >
            {language === 'ar' ? 'EN' : 'عربي'}
          </button>

          {/* Get started CTA */}
          <a
            href={`mailto:${BRAND.supportEmail}`}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-[#160b03] shadow-[0_6px_20px_rgba(176,141,87,0.3)] transition-transform hover:-translate-y-0.5"
          >
            {t('Get started', 'ابدأ الآن')}
          </a>
        </div>
      </div>
    </header>
  );
}
