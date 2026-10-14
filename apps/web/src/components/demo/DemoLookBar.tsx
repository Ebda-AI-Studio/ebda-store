'use client';

import { LOOKS, type LookTemplate } from '@force/shared';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useLanguage } from '../../contexts/LanguageContext';
import { defaultIsLookBuilt, type IsLookBuilt } from '../../lib/demo-look';

/** Template display names (the five looks families). */
const TEMPLATE_NAMES: Record<LookTemplate, { en: string; ar: string }> = {
  qamar: { en: 'Qamar', ar: 'قمر' },
  souq: { en: 'Souq', ar: 'سوق' },
  jasmine: { en: 'Jasmine', ar: 'ياسمين' },
  lamma: { en: 'Lamma', ar: 'لمّة' },
  dahab: { en: 'Dahab', ar: 'دهب' },
};

/**
 * Showroom bar for the demo store (`store.isDemo`): picks a BUILT look to preview. Selecting one
 * navigates to `?look=<id>` on the same path (other query params kept); the server applies it
 * through the normal composition path (see `lib/demo-look.ts`). Designed-only looks are never
 * listed, so with every look still 'designed' the bar renders nothing. `isBuilt` is injectable
 * for tests (default: the registry's `status === 'built'`).
 */
export function DemoLookBar({
  activeLook,
  isBuilt = defaultIsLookBuilt,
}: {
  activeLook?: string | null;
  isBuilt?: IsLookBuilt;
}) {
  const { language, t } = useLanguage();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const built = LOOKS.filter(l => isBuilt(l.id));
  if (built.length === 0) return null;

  const templates = [...new Set(built.map(l => l.template))];

  const select = (lookId: string) => {
    const params = new URLSearchParams(searchParams?.toString() ?? '');
    params.set('look', lookId);
    router.push(`${pathname}?${params.toString()}`);
  };

  return (
    <div
      data-demo-look-bar
      className="sticky top-0 z-50 flex flex-wrap items-center justify-center gap-3 border-b bg-foreground px-4 py-2 text-xs text-background"
    >
      <span className="font-medium">متجر تجريبي · Demo store</span>
      <label className="flex items-center gap-2">
        <span>{t('Look', 'الشكل')}</span>
        <select
          className="min-h-8 rounded border border-background/30 bg-foreground px-2 text-background"
          value={activeLook ?? ''}
          onChange={e => select(e.target.value)}
        >
          {!activeLook || !built.some(l => l.id === activeLook) ? (
            <option value="" disabled>
              {t('Choose a look', 'اختار شكل')}
            </option>
          ) : null}
          {templates.map(tpl => (
            <optgroup key={tpl} label={TEMPLATE_NAMES[tpl][language === 'ar' ? 'ar' : 'en']}>
              {built
                .filter(l => l.template === tpl)
                .map(l => (
                  <option key={l.id} value={l.id}>
                    {l.name[language === 'ar' ? 'ar' : 'en']}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
      </label>
    </div>
  );
}
