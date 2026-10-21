'use client';
import { factText, type ProductFact } from '@ebda/shared';
import { useLanguage } from '@/contexts/LanguageContext';

export function FactsTable({
  facts,
  className = 'mt-6',
}: {
  facts: ProductFact[] | null | undefined;
  className?: string;
}) {
  const { language, t } = useLanguage();
  if (!facts?.length) return null;
  const lang = language === 'ar' ? 'ar' : 'en';
  return (
    <section aria-label={t('Product details', 'تفاصيل المنتج')} className={className}>
      <dl className="divide-y divide-border border-t border-border text-sm">
        {facts.map((f, i) => {
          const x = factText(f, lang);
          return (
            <div key={i} className="grid grid-cols-[minmax(6rem,35%)_1fr] gap-3 py-2">
              <dt className="text-muted-foreground">{x.key}</dt>
              <dd className="text-foreground">{x.value}</dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}
