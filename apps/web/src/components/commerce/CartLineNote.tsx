'use client';
import { useLanguage } from '@/contexts/LanguageContext';

/**
 * "✎ Sara" under a cart / checkout / order line's variant title: the customer's
 * personalisation text, exactly as stored. Renders nothing without a note.
 * Muted ink, like the variant line above it; `bdi` keeps a Latin name inside
 * an Arabic row (and vice versa) in its own direction.
 */
export function CartLineNote({ note, className }: { note?: string | null; className?: string }) {
  const { t } = useLanguage();
  if (!note) return null;
  return (
    <p className={className ?? 'mt-0.5 text-xs text-muted-foreground'}>
      <span aria-hidden="true">✎ </span>
      <span className="sr-only">{t('Personalisation', 'التخصيص')}: </span>
      <bdi>{note}</bdi>
    </p>
  );
}
