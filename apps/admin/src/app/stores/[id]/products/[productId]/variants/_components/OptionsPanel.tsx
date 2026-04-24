'use client';

import { Button } from '@force/ui';
import { useT } from '@/i18n/useT';
import type { Option } from './types';

interface OptionsPanelProps {
  options: Option[];
  onAddOption: () => void;
  onDeleteOption: (optionId: string) => void;
  onDeleteValue: (valueId: string) => void;
  onAddValue: (optionId: string) => void;
  onGenerateVariants: () => void;
}

export function OptionsPanel({
  options,
  onAddOption,
  onDeleteOption,
  onDeleteValue,
  onAddValue,
  onGenerateVariants,
}: OptionsPanelProps) {
  const t = useT('products.variants.options');

  return (
    <div className="lg:col-span-1 space-y-4">
      <div className="rounded-xl border bg-card shadow-sm">
        <div className="flex items-center justify-between border-b p-4">
          <h3 className="font-semibold text-foreground">{t('title')}</h3>
          {options.length < 3 && (
            <Button size="sm" onClick={onAddOption}>
              {t('addOption')}
            </Button>
          )}
        </div>

        {options.length === 0 ? (
          <div className="p-6 text-center text-muted-foreground">
            <p className="text-sm">{t('empty')}</p>
            <p className="text-xs mt-1">{t('emptyHint')}</p>
          </div>
        ) : (
          <div className="divide-y">
            {options.map(option => (
              <div key={option.id} className="p-4">
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <p className="font-medium text-foreground">{option.name}</p>
                    {option.nameAr && (
                      <p className="text-xs text-muted-foreground" dir="rtl">
                        {option.nameAr}
                      </p>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => onDeleteOption(option.id)}
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                      />
                    </svg>
                  </button>
                </div>
                <div className="flex flex-wrap gap-1">
                  {option.values.map(value => (
                    <span
                      key={value.id}
                      className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-1 text-xs"
                    >
                      {value.value}
                      <button
                        type="button"
                        onClick={() => onDeleteValue(value.id)}
                        className="text-muted-foreground hover:text-destructive"
                      >
                        <svg
                          className="h-3 w-3"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M6 18L18 6M6 6l12 12"
                          />
                        </svg>
                      </button>
                    </span>
                  ))}
                  <button
                    type="button"
                    onClick={() => onAddValue(option.id)}
                    className="inline-flex items-center rounded-full bg-primary/10 px-2 py-1 text-xs text-primary hover:bg-primary/20"
                  >
                    {t('addValue')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {options.length > 0 && (
        <Button className="w-full" onClick={onGenerateVariants}>
          <svg className="me-2 h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
            />
          </svg>
          {t('generateAll')}
        </Button>
      )}
    </div>
  );
}
