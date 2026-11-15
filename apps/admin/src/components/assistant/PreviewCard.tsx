'use client';

/**
 * One change the assistant proposes (Smart Layer Phase B, preview class). Shows what will change as before/after rows, applies only when the
 * merchant presses Apply (the assistant mode must be `act`), then offers Undo for 24 hours. A change made by hand since the preview replaces the card
 * with the fresh one and says so. Confirm-class cards (money, deletion, customer messages, big or checkout-visible changes) are NOT applied here:
 * they need their own confirmation step. Everything is plain text; row text that came from a customer or an outside page carries a label.
 */
import { CircleCheck, Undo2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useLocale } from 'next-intl';
import { useT } from '@/i18n/useT';
import { Button } from '@/components/ui/Button';
import type { ApplyData, PreviewCardData, PreviewRowData, UndoData } from '@/lib/assistant';

type Phase =
  | { k: 'idle' }
  | { k: 'busy' }
  | { k: 'applied'; appliedId: string; until: number }
  | { k: 'undone' }
  | { k: 'failed'; why: 'forbidden' | 'expired' | 'killed' | 'error' };

export const show = (v: unknown): string => {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'string') return v.length > 300 ? `${v.slice(0, 300)}…` : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const j = JSON.stringify(v);
  return j.length > 300 ? `${j.slice(0, 300)}…` : j;
};

const hoursLeft = (until: number, now: number): number =>
  Math.max(0, Math.ceil((until - now) / 3_600_000));

export function PreviewCard({
  card: first,
  mode,
  onApply,
  onUndo,
  now = () => Date.now(),
}: {
  card: PreviewCardData;
  mode: 'answer-only' | 'suggest' | 'act';
  onApply: (previewId: string) => Promise<{ data?: ApplyData; error?: { code: string } }>;
  onUndo: (appliedId: string) => Promise<{ data?: UndoData; error?: { code: string } }>;
  now?: () => number;
}) {
  const t = useT('assistant');
  const lang = useLocale() === 'en' ? 'en' : 'ar';
  const [card, setCard] = useState(first);
  const [phase, setPhase] = useState<Phase>({ k: 'idle' });
  const [notice, setNotice] = useState<'stale' | null>(null);
  const [tick, setTick] = useState(now());

  useEffect(() => {
    if (phase.k !== 'applied') return;
    const id = setInterval(() => setTick(now()), 30_000);
    return () => clearInterval(id);
  }, [phase, now]);

  const failWith = (code?: string) =>
    setPhase({
      k: 'failed',
      why:
        code === 'FORBIDDEN'
          ? 'forbidden'
          : code === 'EXPIRED'
            ? 'expired'
            : code === 'ASSISTANT_OFF'
              ? 'killed'
              : 'error',
    });

  const apply = async () => {
    setPhase({ k: 'busy' });
    const r = await onApply(card.previewId);
    if (r.error || !r.data) return failWith(r.error?.code);
    if (r.data.status === 'stale') {
      setCard(r.data.card);
      setNotice('stale');
      return setPhase({ k: 'idle' });
    }
    setNotice(null);
    setPhase({ k: 'applied', appliedId: r.data.appliedId, until: r.data.undoUntil });
    setTick(now());
  };
  const undo = async () => {
    if (phase.k !== 'applied') return;
    const was = phase;
    setPhase({ k: 'busy' });
    const r = await onUndo(was.appliedId);
    if (r.error || !r.data) {
      setPhase(was);
      return failWith(r.error?.code);
    }
    if (r.data.status === 'undone') return setPhase({ k: 'undone' });
    // changed by hand since (or needs its own confirmation): show what undo would do as a fresh card, nothing was written
    setCard(r.data.card);
    setNotice('stale');
    setPhase({ k: 'idle' });
  };

  const confirmClass = card.policy === 'confirm';
  const left = phase.k === 'applied' ? hoursLeft(phase.until, tick) : 0;
  const canUndo =
    phase.k === 'applied' &&
    phase.until > tick &&
    card.undo !== 'irreversible' &&
    card.undo !== 'none';

  return (
    <article
      data-testid="preview-card"
      data-policy={card.policy}
      aria-label={t('card.label')}
      className="grid gap-2 rounded-xl border border-border bg-background p-3 text-sm"
    >
      <p className="font-medium" dir="auto">
        {card.summary[lang]}
      </p>
      {notice === 'stale' && (
        <p role="status" className="text-xs text-muted-foreground">
          {t('card.stale')}
        </p>
      )}
      <ul className="m-0 grid list-none gap-1.5 p-0">
        {card.rows.map((r: PreviewRowData, i) => (
          <li key={i} className="grid gap-0.5 rounded-lg bg-muted/60 px-2.5 py-1.5">
            <span className="text-xs text-muted-foreground">{r.label[lang]}</span>
            <span className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-2">
              <span className="text-xs text-muted-foreground">{t('card.before')}</span>
              <span dir="auto" className="break-words line-through decoration-muted-foreground/60">
                {show(r.before)}
              </span>
              <span className="text-xs text-muted-foreground">{t('card.after')}</span>
              <span dir="auto" className="break-words font-medium">
                {show(r.after)}
              </span>
            </span>
            {r.source === 'untrusted' && (
              <span className="text-xs text-muted-foreground">{t('card.untrusted')}</span>
            )}
          </li>
        ))}
      </ul>

      {phase.k === 'applied' && (
        <p role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <CircleCheck className="h-4 w-4" aria-hidden="true" />
          {canUndo ? t('card.applied') : t('card.appliedNoUndo')}
        </p>
      )}
      {phase.k === 'undone' && (
        <p role="status" className="text-xs text-muted-foreground">
          {t('card.undone')}
        </p>
      )}
      {phase.k === 'failed' && (
        <p role="alert" className="text-xs text-destructive-ink">
          {t(`card.failed.${phase.why}`)}
        </p>
      )}

      {confirmClass ? (
        <p role="note" className="text-xs text-muted-foreground">
          {t('card.needsConfirm')}
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {(phase.k === 'idle' || phase.k === 'busy' || phase.k === 'failed') && (
            <Button
              type="button"
              size="sm"
              disabled={phase.k === 'busy' || mode !== 'act'}
              aria-describedby={mode !== 'act' ? `${card.previewId}-mode` : undefined}
              onClick={() => void apply()}
            >
              {phase.k === 'busy' ? t('card.applying') : t('card.apply')}
            </Button>
          )}
          {canUndo && (
            <Button type="button" size="sm" variant="outline" onClick={() => void undo()}>
              <Undo2 className="h-4 w-4" aria-hidden="true" />
              {t('card.undo', { hours: left })}
            </Button>
          )}
        </div>
      )}
      {!confirmClass && mode !== 'act' && phase.k !== 'applied' && (
        <p id={`${card.previewId}-mode`} className="text-xs text-muted-foreground">
          {t('card.suggestionMode')}
        </p>
      )}
    </article>
  );
}
