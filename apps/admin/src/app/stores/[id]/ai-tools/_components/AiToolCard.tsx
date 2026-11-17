'use client';

import { useId, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import { SparkleIcon } from '@/components/SparkleIcon';

/**
 * One AI tool, one card shape. Top to bottom: what it is (title), what you get (outcome), how it works (body), what it
 * costs (AI-call line), the replace switch when the tool can overwrite, then the run button pinned to the card's foot so
 * a row of cards lines its buttons up whatever the copy length. Everything is a prop so the card is pure and testable.
 */
interface AiToolCardProps {
  /** DOM id, also the anchor other cards link to (e.g. the undo hint). */
  id: string;
  title: string;
  outcome: string;
  body: string;
  costLabel: string;
  buttonLabel: string;
  startingLabel: string;
  loading: boolean;
  /** Why the run button is off (another run, quota, AI switched off); null = it can run. */
  blockedReason: string | null;
  onRun: (force: boolean) => void;
  /** Present only when the server can overwrite existing content for this tool. */
  replace?: { label: string; hint: string; noUndo: string | null };
  /** Shown instead of the replace switch when the tool must never overwrite (says why, in plain words). */
  fillOnlyNote?: string;
  results?: { href: string; label: string };
  /** The undo tool: secondary button, so the one gold action per card stays the forward one. */
  isUndo?: boolean;
}

function Spinner() {
  return (
    <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
  );
}

export function AiToolCard(props: AiToolCardProps) {
  const {
    id,
    title,
    outcome,
    body,
    costLabel,
    buttonLabel,
    startingLabel,
    loading,
    blockedReason,
    onRun,
    replace,
    fillOnlyNote,
    results,
    isUndo,
  } = props;
  const [force, setForce] = useState(false);
  const uid = useId();
  const reasonId = `${uid}-reason`;
  const checkId = `${uid}-replace`;
  const disabled = loading || blockedReason !== null;

  return (
    <article
      id={id}
      aria-labelledby={`${uid}-title`}
      data-testid={id}
      className="flex scroll-mt-24 flex-col rounded-xl border bg-card p-5 shadow-sm"
    >
      <h3 id={`${uid}-title`} className="text-base font-semibold leading-snug text-foreground">
        {title}
      </h3>
      <p className="mt-1.5 text-sm font-medium leading-relaxed text-foreground">{outcome}</p>
      <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{body}</p>

      <p
        className="mt-3 inline-flex items-start gap-1.5 text-xs text-muted-foreground"
        data-testid="tool-cost"
      >
        <SparkleIcon className="mt-px h-3.5 w-3.5 text-primary-ink" />
        <span>{costLabel}</span>
      </p>

      {replace && (
        <div className="mt-3">
          <label
            htmlFor={checkId}
            className="flex min-h-11 cursor-pointer select-none items-center gap-2 text-sm text-foreground sm:min-h-8"
          >
            <input
              id={checkId}
              type="checkbox"
              checked={force}
              onChange={e => setForce(e.target.checked)}
              className="h-4 w-4 shrink-0 cursor-pointer accent-primary"
            />
            <span>{replace.label}</span>
          </label>
          {force && (
            <p
              role="status"
              className="mt-1 rounded-md bg-warning/10 px-3 py-2 text-xs leading-relaxed text-warning-ink"
              data-testid="replace-hint"
            >
              {replace.hint}
              {replace.noUndo ? ` ${replace.noUndo}` : ''}
            </p>
          )}
        </div>
      )}

      {!replace && fillOnlyNote && (
        <p className="mt-3 text-xs text-muted-foreground" data-testid="fill-only-note">
          {fillOnlyNote}
        </p>
      )}

      <div className="mt-auto pt-4">
        <Button
          variant={isUndo ? 'outline' : 'default'}
          size="md"
          className="w-full"
          type="button"
          onClick={() => onRun(replace ? force : false)}
          disabled={disabled}
          aria-describedby={blockedReason ? reasonId : undefined}
        >
          {loading ? <Spinner /> : isUndo ? null : <SparkleIcon />}
          <span>{loading ? startingLabel : buttonLabel}</span>
        </Button>
        {blockedReason && (
          <p
            id={reasonId}
            className="mt-2 text-xs text-muted-foreground"
            data-testid="blocked-reason"
          >
            {blockedReason}
          </p>
        )}
        {results && (
          <Link
            href={results.href}
            className="mt-3 inline-flex min-h-8 items-center gap-1 text-sm font-medium text-primary-ink hover:underline"
          >
            {results.label}
            <span aria-hidden className="inline-block rtl:-scale-x-100">
              →
            </span>
          </Link>
        )}
      </div>
    </article>
  );
}
