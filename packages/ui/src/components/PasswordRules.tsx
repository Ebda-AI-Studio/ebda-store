import * as React from 'react';
import { PASSWORD_POLICY_TITLE, passwordRuleResults } from '@ebda/shared';
import { cn } from '../utils/cn';

interface PasswordRulesProps {
  /** The password as typed (never logged or stored here). */
  value: string;
  /** Language of the labels; they come from the shared policy so form and server can never disagree. */
  locale: 'ar' | 'en';
  /** Heading override (admin passes its `useT` string); defaults to the shared bilingual title. */
  title?: string;
  /** Screen-reader sentence, e.g. "3 of 5 requirements met". Receives met + total. */
  progressLabel?: (met: number, total: number) => string;
  id?: string;
  className?: string;
}

const defaultProgress = (locale: 'ar' | 'en') => (met: number, total: number) =>
  locale === 'ar' ? `${met} من ${total} شروط متحققة` : `${met} of ${total} requirements met`;

/**
 * Live password-rules checklist. Ticks as the user types. The status is never colour alone (check vs ring icon plus a
 * visually-hidden "met / not yet"), the polite live region only changes when the NUMBER of met rules changes (so a
 * screen reader hears progress, not every keystroke), and layout uses logical properties so it mirrors in RTL.
 */
export function PasswordRules({
  value,
  locale,
  title,
  progressLabel,
  id,
  className,
}: PasswordRulesProps) {
  const reactId = React.useId();
  const baseId = id ?? `pwr-${reactId}`;
  const results = passwordRuleResults(value);
  const met = results.filter(r => r.met).length;
  const progress = (progressLabel ?? defaultProgress(locale))(met, results.length);
  const metWord = locale === 'ar' ? 'متحقق' : 'met';
  const notYetWord = locale === 'ar' ? 'لسه' : 'not yet';

  return (
    <div id={baseId} className={cn('text-xs', className)} dir={locale === 'ar' ? 'rtl' : 'ltr'}>
      <p id={`${baseId}-title`} className="mb-1 font-medium text-foreground">
        {title ?? PASSWORD_POLICY_TITLE[locale]}
      </p>
      <ul
        aria-labelledby={`${baseId}-title`}
        className="grid grid-cols-1 gap-x-3 gap-y-0.5 sm:grid-cols-2"
      >
        {results.map(({ rule, met: ok }) => (
          <li
            key={rule.id}
            data-rule={rule.id}
            data-met={ok ? 'true' : 'false'}
            className={cn(
              'flex items-center gap-1.5',
              ok ? 'text-success-ink' : 'text-muted-foreground'
            )}
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 16 16"
              className="h-3.5 w-3.5 shrink-0"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              {ok ? (
                <>
                  <circle cx="8" cy="8" r="6.5" fill="currentColor" fillOpacity="0.15" />
                  <path d="M5 8.2l2.1 2.1L11 6.2" />
                </>
              ) : (
                <circle cx="8" cy="8" r="6.5" />
              )}
            </svg>
            <span>{rule[locale]}</span>
            <span className="sr-only">{ok ? metWord : notYetWord}</span>
          </li>
        ))}
      </ul>
      <p role="status" aria-live="polite" className="sr-only">
        {progress}
      </p>
    </div>
  );
}
