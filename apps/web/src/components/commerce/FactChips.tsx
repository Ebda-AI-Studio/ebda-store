'use client';
import { cardFacts, factText, type ProductFact } from '@ebda/shared';
import { useLanguage } from '@/contexts/LanguageContext';

/**
 * Up to two merchant-pinned fact chips on a product card (value only, e.g. "كتان").
 * Ink/muted tokens, no accent. Renders nothing until a merchant pins a fact.
 */
export function FactChips({
  product,
  className = '',
}: {
  product: { facts?: ProductFact[] | null };
  className?: string;
}) {
  const { language } = useLanguage();
  const rows = cardFacts(product.facts);
  if (!rows.length) return null;
  const lang = language === 'ar' ? 'ar' : 'en';
  return (
    <div
      data-card-chrome="tags"
      className={`flex flex-wrap items-center gap-1 ${className}`.trim()}
    >
      {rows.map((f, i) => (
        <span
          key={i}
          data-testid="fact-chip"
          className="rounded-[var(--radius)] border border-foreground/15 px-1.5 py-0.5 text-xs leading-normal text-muted-foreground"
        >
          {factText(f, lang).value}
        </span>
      ))}
    </div>
  );
}
