'use client';

import { buttonVariants } from '@/components/ui/Button';
import Link from 'next/link';
import { useT } from '@/i18n/useT';
import { engineLabel, type AnswerEngineSummaryPrompt } from './types';

interface PromptResultsListProps {
  storeId: string;
  prompts: AnswerEngineSummaryPrompt[];
}

/**
 * Latest per-prompt win/lose list. Each "not cited" row gets an actionable
 * rec that deep-links to the GEO section of the AI Tools page — the
 * `bulk-ai-citation-copy` sweep (`/bulk/citation-copy` in
 * `apps/api/src/lib/inngest/functions/bulk-ai-geo.ts`, triggered from
 * `stores/[id]/ai-tools/page.tsx`'s GEO card) rewrites product descriptions
 * specifically to improve LLM citation — the direct fix for a prompt this
 * store lost.
 */
export function PromptResultsList({ storeId, prompts }: PromptResultsListProps) {
  const t = useT('answerEngine.page');

  if (prompts.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('noData')}</p>;
  }

  return (
    <div className="bg-card rounded-md border border-border shadow-sm overflow-hidden">
      <h2 className="text-lg font-semibold text-foreground px-6 pt-6">{t('promptsTitle')}</h2>
      <ul className="divide-y divide-border mt-3">
        {prompts.map(prompt => (
          <li key={`${prompt.engine}::${prompt.promptText}`} className="px-6 py-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground" dir="auto">
                  {prompt.cited ? '✅' : '❌'} {prompt.promptText}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {engineLabel(prompt.engine)} · {prompt.locale.toUpperCase()}
                </p>
                {prompt.cited && prompt.snippet && (
                  <p className="mt-1.5 text-xs text-muted-foreground italic" dir="auto">
                    &ldquo;{prompt.snippet}&rdquo;
                  </p>
                )}
                {!prompt.cited && prompt.competitorUrls.length > 0 && (
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    {t('citedInstead')}{' '}
                    {prompt.competitorUrls.map(url => (
                      <span
                        key={url}
                        className="inline-block mr-1.5 rtl:mr-0 rtl:ml-1.5 rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs"
                      >
                        {url.replace(/^https?:\/\//, '')}
                      </span>
                    ))}
                  </p>
                )}
              </div>
              {!prompt.cited && (
                <Link
                  href={`/stores/${storeId}/ai-tools`}
                  className={buttonVariants({ variant: 'soft', size: 'sm', className: 'shrink-0' })}
                >
                  {t('recCta')}
                </Link>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
