'use client';

/**
 * The page's own settings (Task 8e, Ruling VE-13): shown in the right pane when nothing is selected. One
 * group per layout key the page owns (background, spacing, text size, filters, reviews, image shapes, the
 * phone bottom bar, product cards...), generated from `PAGE_SETTINGS` and rendered with the same field
 * components as a section's settings. Every change is a `setSiteSetting` on the draft; the canvas
 * repaints, and nothing is live until Publish.
 */
import { useLocale } from 'next-intl';
import {
  PAGE_KIND_LABELS,
  PAGE_SETTINGS,
  type DocumentAction,
  type PageDefinition,
  type PageKind,
  type StoreTheme,
} from '@ebda/shared';
import { useT } from '@/i18n/useT';
import { Field } from './SettingsPanel';
import { Disclosure } from '../../../../../components/ui/Disclosure';

/** The value at `a` or `a.b` inside a settings group. */
function valueAt(group: unknown, path: string): unknown {
  const [head, ...rest] = path.split('.');
  const v = (group as Record<string, unknown> | undefined)?.[head];
  return rest.length ? (v as Record<string, unknown> | undefined)?.[rest[0]] : v;
}

export function PageSettingsPanel({
  storeId,
  pageKey,
  doc,
  theme,
  dispatch,
  onSwitchPage,
}: {
  storeId: string;
  pageKey: PageKind;
  doc: PageDefinition;
  theme: StoreTheme | undefined;
  dispatch: (action: DocumentAction, coalesceKey?: string) => unknown;
  onSwitchPage?: (next: PageKind) => void;
}) {
  const t = useT('builder.pageSettings');
  const locale = useLocale();
  const groups = PAGE_SETTINGS[pageKey];
  return (
    <div
      className="flex h-full flex-col"
      data-testid="page-settings-panel"
      data-setting-id="builder.page-settings"
    >
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">
          {t('title', {
            page: locale === 'ar' ? PAGE_KIND_LABELS[pageKey].ar : PAGE_KIND_LABELS[pageKey].en,
          })}
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">{t('hint')}</p>
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {groups.map((g, i) => {
          const group = doc.siteSettings[g.key];
          return (
            <Disclosure
              key={g.key}
              defaultOpen={i === 0}
              testId={`page-settings-${g.key}`}
              title={locale === 'ar' ? g.labelAr : g.labelEn}
            >
              <div className="space-y-4">
                {g.settings.map(s => (
                  <Field
                    key={s.id}
                    def={s}
                    storeId={storeId}
                    theme={theme}
                    locale={locale}
                    valueOf={path => valueAt(group, path) ?? s.default}
                    overridden={false}
                    viewport="desktop"
                    onChange={(path, value) =>
                      dispatch(
                        { type: 'setSiteSetting', key: g.key, path, value },
                        `site/${g.key}/${path}`
                      )
                    }
                    onReset={() => {}}
                    sectionType={g.key}
                  />
                ))}
              </div>
            </Disclosure>
          );
        })}
        {pageKey !== 'home' && onSwitchPage && (
          <p className="rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
            {t('cardsOnHome')}{' '}
            <button
              type="button"
              onClick={() => onSwitchPage('home')}
              className="text-primary hover:underline"
              data-testid="page-settings-to-home"
            >
              {t('openHome')}
            </button>
          </p>
        )}
      </div>
    </div>
  );
}
