'use client';

import { useLanguage } from '../../contexts/LanguageContext';

/**
 * Sprint 4 (2026-05-17): PDP key-value spec table. Observed on
 * Pecannbee PDP (IMG_7993 "Specifications" section: "Size: 300 Gram").
 * Renders structured product specifications from
 * `product.specifications` JSON (already in schema). Returns null when
 * no specs are present — no empty section, no chrome bloat.
 *
 * Schema shape supported:
 *   - `Record<string, string>` (simplest — `{ "Size": "300g", "Origin": "Spain" }`)
 *   - `Array<{ label: string; value: string; labelAr?: string; valueAr?: string }>`
 *     (bilingual variant)
 *
 * Future per-row bilingual will land via admin spec-editor; today
 * platform tolerates either shape and falls back to the EN/AR string
 * directly when no bilingual variant is provided.
 */

type SpecLike =
  | Record<string, string>
  | Array<{ label: string; value: string; labelAr?: string; valueAr?: string }>
  | null
  | undefined;

interface SpecTableProps {
  specifications: SpecLike;
  className?: string;
}

export function SpecTable({ specifications, className = '' }: SpecTableProps) {
  const { isRtl, t } = useLanguage();
  const rows = normalize(specifications);
  if (rows.length === 0) return null;

  return (
    <section
      aria-label={t('Specifications', 'المواصفات')}
      dir={isRtl ? 'rtl' : 'ltr'}
      className={`rounded-lg border border-foreground/10 ${className}`}
    >
      <header className="border-b border-foreground/10 px-4 py-3">
        <h3 className="text-sm font-semibold text-foreground">
          {isRtl ? 'المواصفات' : 'Specifications'}
        </h3>
      </header>
      <dl className="divide-y divide-foreground/5">
        {rows.map(row => {
          const label = isRtl && row.labelAr ? row.labelAr : row.label;
          const value = isRtl && row.valueAr ? row.valueAr : row.value;
          return (
            <div
              key={row.label}
              className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] gap-3 px-4 py-2.5 text-sm"
            >
              <dt className="text-foreground/70 font-medium">{label}</dt>
              <dd className="text-foreground">{value}</dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}

function normalize(
  specs: SpecLike
): Array<{ label: string; value: string; labelAr?: string; valueAr?: string }> {
  if (!specs) return [];
  if (Array.isArray(specs)) {
    return specs.filter(r => r && typeof r.label === 'string' && typeof r.value === 'string');
  }
  if (typeof specs === 'object') {
    return Object.entries(specs)
      .filter(([k, v]) => typeof k === 'string' && typeof v === 'string')
      .map(([label, value]) => ({ label, value }));
  }
  return [];
}
