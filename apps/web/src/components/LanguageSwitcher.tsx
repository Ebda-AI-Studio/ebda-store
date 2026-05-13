'use client';

import { useLanguage } from '../contexts/LanguageContext';

interface LanguageSwitcherProps {
  variant?: 'default' | 'compact';
  className?: string;
}

export function LanguageSwitcher({ variant = 'default', className = '' }: LanguageSwitcherProps) {
  const { language, setLanguage } = useLanguage();

  if (variant === 'compact') {
    return (
      <button
        onClick={() => setLanguage(language === 'en' ? 'ar' : 'en')}
        className={`flex h-11 w-11 items-center justify-center rounded-xl text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground ${className}`}
        aria-label={language === 'en' ? 'Switch to Arabic' : 'Switch to English'}
      >
        {language === 'en' ? 'ع' : 'En'}
      </button>
    );
  }

  return (
    <div
      className={`flex items-center gap-1 rounded-xl border border-border bg-background p-1 ${className}`}
    >
      <button
        onClick={() => setLanguage('en')}
        className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
          language === 'en'
            ? 'bg-primary text-white shadow-sm'
            : 'text-muted-foreground hover:text-foreground'
        }`}
      >
        English
      </button>
      <button
        onClick={() => setLanguage('ar')}
        className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
          language === 'ar'
            ? 'bg-primary text-white shadow-sm'
            : 'text-muted-foreground hover:text-foreground'
        }`}
      >
        العربية
      </button>
    </div>
  );
}
