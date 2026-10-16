'use client';

import { useLanguage } from '../contexts/LanguageContext';

interface LanguageSwitcherProps {
  variant?: 'default' | 'compact';
  className?: string;
}

/**
 * R-05: the accessible name is in the page's language (an Arabic page never
 * hears "Switch to English"), and every language's own name carries its `lang`
 * so a screen reader voices "العربية" / "English" in the right voice.
 */
export function LanguageSwitcher({ variant = 'default', className = '' }: LanguageSwitcherProps) {
  const { language, setLanguage, t } = useLanguage();

  if (variant === 'compact') {
    const target = language === 'en' ? 'ar' : 'en';
    return (
      <button
        type="button"
        onClick={() => setLanguage(target)}
        className={`flex h-11 w-11 items-center justify-center rounded-xl text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground ${className}`}
      >
        {/* Name: "التبديل إلى English" / "Switch to العربية", the target language's own
            name voiced in its own language; the glyph is the visual shorthand. */}
        <span className="sr-only">{t('Switch to', 'التبديل إلى')} </span>
        <span lang={target} className="sr-only">
          {target === 'ar' ? 'العربية' : 'English'}
        </span>
        <span lang={target} aria-hidden="true">
          {target === 'ar' ? 'ع' : 'En'}
        </span>
      </button>
    );
  }

  return (
    <div
      role="group"
      aria-label={t('Language', 'اللغة')}
      className={`flex items-center gap-1 rounded-xl border border-border bg-background p-1 ${className}`}
    >
      <button
        type="button"
        lang="en"
        aria-pressed={language === 'en'}
        onClick={() => setLanguage('en')}
        className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
          language === 'en'
            ? 'bg-primary text-primary-foreground shadow-sm'
            : 'text-muted-foreground hover:text-foreground'
        }`}
      >
        English
      </button>
      <button
        type="button"
        lang="ar"
        aria-pressed={language === 'ar'}
        onClick={() => setLanguage('ar')}
        className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
          language === 'ar'
            ? 'bg-primary text-primary-foreground shadow-sm'
            : 'text-muted-foreground hover:text-foreground'
        }`}
      >
        العربية
      </button>
    </div>
  );
}
