'use client';

import { PasswordRules } from '@ebda/ui';
import { useLanguage } from '../contexts/LanguageContext';

/** The shared live password-rules checklist in the shopper's language (rules + labels: @ebda/shared password-policy). */
export function PasswordChecklist({ value, id }: { value: string; id?: string }) {
  const { language } = useLanguage();
  return (
    <PasswordRules
      value={value}
      locale={language === 'ar' ? 'ar' : 'en'}
      id={id}
      className="-mt-2"
    />
  );
}
