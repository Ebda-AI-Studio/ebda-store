'use client';

import { useState } from 'react';
import { useToast } from '@ebda/ui';
import { useT } from '@/i18n/useT';
import { Button } from '@/components/ui/Button';
import { feedUrl, type FeedLang, type PlatformKey } from './types';

const LANGS: FeedLang[] = ['ar', 'en'];
const STEPS = ['step1', 'step2', 'step3', 'step4', 'step5'] as const;

/** One platform: what it is for, the two language links with copy buttons, and the setup steps. */
export function PlatformCard({ platform, origin }: { platform: PlatformKey; origin: string }) {
  const t = useT('productFeeds');
  const toast = useToast();
  const [open, setOpen] = useState(false);

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success(t('copied'));
    } catch {
      toast.error(t('copyFailed'));
    }
  };

  return (
    <section
      className="bg-card rounded-xl border border-border p-5 flex flex-col gap-4"
      aria-labelledby={`feed-${platform}`}
    >
      <header>
        <h2 id={`feed-${platform}`} className="text-base font-semibold text-foreground" dir="auto">
          {t(`platforms.${platform}.name`)}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground" dir="auto">
          {t(`platforms.${platform}.for`)} · {t(`platforms.${platform}.format`)}
        </p>
      </header>

      <div className="space-y-3">
        {LANGS.map(lang => {
          const url = feedUrl(origin, platform, lang);
          return (
            <div key={lang}>
              <label
                htmlFor={`feed-${platform}-${lang}`}
                className="block text-xs font-medium text-muted-foreground mb-1"
              >
                {t(`language.${lang}`)}
              </label>
              <div className="flex items-center gap-2">
                <input
                  id={`feed-${platform}-${lang}`}
                  readOnly
                  dir="ltr"
                  value={url}
                  onFocus={e => e.currentTarget.select()}
                  className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-2 text-xs font-mono text-foreground"
                />
                <Button type="button" variant="outline" size="sm" onClick={() => copy(url)}>
                  {t('copy')}
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      <div>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={`feed-${platform}-steps`}
          onClick={() => setOpen(o => !o)}
          className="text-sm font-medium text-primary hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary rounded"
        >
          {t('steps')}
        </button>
        {open && (
          <ol
            id={`feed-${platform}-steps`}
            className="mt-3 space-y-2 ps-5 list-decimal text-sm text-foreground"
            dir="auto"
          >
            {STEPS.map(s => (
              <li key={s}>{t(`platforms.${platform}.${s}`)}</li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
