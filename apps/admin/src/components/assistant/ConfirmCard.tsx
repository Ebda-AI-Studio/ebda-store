'use client';

/**
 * A change that needs the merchant's explicit "yes" (Smart Layer Phase C): money, deleting, a message to customers, more than 20 items, anything
 * customers see at checkout, a price change, or something that cannot be undone. The gold button is the ONLY way it is applied: it calls the
 * confirm route with the one-time token the server handed this page. Typing "yes" in the chat does nothing. The card shows exactly what will happen
 * (rows), why it needs a "yes" (reason chips), the credit cost when there is one, and says plainly when it cannot be undone.
 */
import { Undo2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useLocale } from 'next-intl';
import { useT } from '@/i18n/useT';
import { Button } from '@/components/ui/Button';
import type { ConfirmData, PreviewCardData, PreviewRowData, UndoData } from '@/lib/assistant';
import { show } from './PreviewCard';

type Phase =
  | { k: 'idle' }
  | { k: 'busy' }
  | { k: 'applied'; appliedId: string; until: number }
  | { k: 'rejected' }
  | { k: 'undone' }
  | { k: 'failed'; why: 'forbidden' | 'expired' | 'used' | 'killed' | 'error' };

const REASONS = [
  'money',
  'delete',
  'customer_message',
  'bulk',
  'checkout',
  'price',
  'irreversible',
] as const;
const hoursLeft = (until: number, now: number): number =>
  Math.max(0, Math.ceil((until - now) / 3_600_000));

export function ConfirmCard({
  card: first,
  token: firstToken,
  onConfirm,
  onReject,
  onUndo,
  onFresh,
  now = () => Date.now(),
}: {
  card: PreviewCardData;
  /** The one-time token for THIS card (kept in memory by the panel; gone after a reload, then the card asks to be prepared again). */
  token: string | undefined;
  onConfirm: (
    approvalId: string,
    token: string
  ) => Promise<{ data?: ConfirmData; error?: { code: string } }>;
  onReject: (approvalId: string) => Promise<{ error?: { code: string } }>;
  onUndo: (appliedId: string) => Promise<{ data?: UndoData; error?: { code: string } }>;
  /** A changed-since card brings its own approval token. */
  onFresh?: (approvalId: string, token: string) => void;
  now?: () => number;
}) {
  const t = useT('assistant');
  const lang = useLocale() === 'en' ? 'en' : 'ar';
  const [card, setCard] = useState(first);
  const [token, setToken] = useState(firstToken);
  const [phase, setPhase] = useState<Phase>({ k: 'idle' });
  const [stale, setStale] = useState(false);
  const [tick, setTick] = useState(now());

  useEffect(() => {
    if (phase.k !== 'applied') return;
    const id = setInterval(() => setTick(now()), 30_000);
    return () => clearInterval(id);
  }, [phase, now]);

  const fail = (code?: string) =>
    setPhase({
      k: 'failed',
      why:
        code === 'FORBIDDEN'
          ? 'forbidden'
          : code === 'EXPIRED'
            ? 'expired'
            : code === 'APPROVAL_USED' || code === 'APPROVAL_MISMATCH' || code === 'NOT_PENDING'
              ? 'used'
              : code === 'ASSISTANT_OFF' || code === 'ASSISTANT_MODE'
                ? 'killed'
                : 'error',
    });

  const confirm = async () => {
    if (!card.approvalId || !token) return;
    setPhase({ k: 'busy' });
    const r = await onConfirm(card.approvalId, token);
    if (r.error || !r.data) return fail(r.error?.code);
    if (r.data.status === 'stale') {
      const grant = r.data.approvals?.find(a => a.approvalId === r.data!.card.approvalId);
      setCard(r.data.card);
      setToken(grant?.token);
      if (grant) onFresh?.(grant.approvalId, grant.token);
      setStale(true);
      return setPhase({ k: 'idle' });
    }
    setStale(false);
    setPhase({ k: 'applied', appliedId: r.data.appliedId, until: r.data.undoUntil });
    setTick(now());
  };
  const reject = async () => {
    if (!card.approvalId) return;
    setPhase({ k: 'busy' });
    const r = await onReject(card.approvalId);
    if (r.error) return fail(r.error.code);
    setPhase({ k: 'rejected' });
  };
  const undo = async () => {
    if (phase.k !== 'applied') return;
    const was = phase;
    setPhase({ k: 'busy' });
    const r = await onUndo(was.appliedId);
    if (r.error || !r.data) {
      setPhase(was);
      return fail(r.error?.code);
    }
    if (r.data.status === 'undone') return setPhase({ k: 'undone' });
    setCard(r.data.card);
    setStale(true);
    setPhase({ k: 'idle' });
  };

  const irreversible = card.undo === 'irreversible' || card.undo === 'none';
  const canUndo = phase.k === 'applied' && !irreversible && phase.until > tick;
  const decided = phase.k === 'applied' || phase.k === 'rejected' || phase.k === 'undone';
  const reasons = REASONS.filter(r => card.reasons.includes(r));

  return (
    <article
      data-testid="confirm-card"
      data-policy="confirm"
      aria-label={t('confirm.label')}
      className="grid gap-2 rounded-xl border border-primary/60 bg-background p-3 text-sm"
    >
      <p className="font-medium" dir="auto">
        {card.summary[lang]}
      </p>
      {reasons.length > 0 && (
        <ul aria-label={t('confirm.why')} className="m-0 flex list-none flex-wrap gap-1.5 p-0">
          {reasons.map(r => (
            <li key={r} className="rounded-full bg-muted px-2 py-0.5 text-xs">
              {t(`confirm.reasons.${r}`)}
            </li>
          ))}
        </ul>
      )}
      {stale && (
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
      {card.costCredits !== undefined && (
        <p className="text-xs text-muted-foreground">
          {t('confirm.cost', { credits: card.costCredits })}
        </p>
      )}
      {irreversible && !decided && (
        <p role="note" className="text-xs font-medium">
          {t('confirm.irreversible')}
        </p>
      )}

      {phase.k === 'applied' && (
        <p role="status" className="text-xs text-muted-foreground">
          {canUndo
            ? t('card.applied')
            : irreversible
              ? t('confirm.appliedFinal')
              : t('card.appliedNoUndo')}
        </p>
      )}
      {phase.k === 'rejected' && (
        <p role="status" className="text-xs text-muted-foreground">
          {t('confirm.rejected')}
        </p>
      )}
      {phase.k === 'undone' && (
        <p role="status" className="text-xs text-muted-foreground">
          {t('card.undone')}
        </p>
      )}
      {phase.k === 'failed' && (
        <p role="alert" className="text-xs text-destructive-ink">
          {t(`confirm.failed.${phase.why}`)}
        </p>
      )}
      {!token && !decided && (
        <p role="note" className="text-xs text-muted-foreground">
          {t('confirm.noToken')}
        </p>
      )}

      {!decided && token && card.approvalId && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            disabled={phase.k === 'busy'}
            onClick={() => void confirm()}
          >
            {phase.k === 'busy' ? t('card.applying') : t('confirm.yes')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={phase.k === 'busy'}
            onClick={() => void reject()}
          >
            {t('confirm.no')}
          </Button>
        </div>
      )}
      {canUndo && (
        <div className="flex">
          <Button type="button" size="sm" variant="outline" onClick={() => void undo()}>
            <Undo2 className="h-4 w-4" aria-hidden="true" />
            {t('card.undo', { hours: hoursLeft((phase as { until: number }).until, tick) })}
          </Button>
        </div>
      )}
    </article>
  );
}
