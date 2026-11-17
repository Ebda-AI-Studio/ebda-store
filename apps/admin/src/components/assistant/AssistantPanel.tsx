'use client';

/**
 * The assistant side panel (Smart Layer Phase A, answer-only). Opens from the dock or Ctrl/Cmd + J, closes with Esc, keeps focus inside and gives it back
 * on close. It shows what the server says and nothing more: every limit, refusal and "not covered" arrives as words from the server in the asked language.
 */
import { ArrowUp, CircleAlert, ThumbsDown, ThumbsUp, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale } from 'next-intl';
import { useT } from '@/i18n/useT';
import {
  conversationIdFor,
  forgetConversation,
  applyPreview,
  confirmApproval,
  getConversation,
  postTurn,
  rejectApproval,
  sendFeedback,
  undoApplied,
  type AssistantMode,
  type AssistantSegment,
  type AssistantStatus,
  type PreviewCardData,
} from '@/lib/assistant';
import { Button } from '@/components/ui/Button';
import { TEXTAREA_CLASSES } from '@/components/ui/tokens';
import { Segments } from './Citation';
import { ConfirmCard } from './ConfirmCard';
import { PreviewCard } from './PreviewCard';

const MAX = 2000;
type Item =
  | { id: string; role: 'merchant'; text: string }
  | {
      id: string;
      role: 'assistant';
      segments: AssistantSegment[];
      turnId?: string;
      status?: AssistantStatus;
      previews?: PreviewCardData[];
    };

export function AssistantPanel({
  storeId,
  userId,
  mode = 'answer-only',
  onClose,
  onUnavailable,
}: {
  storeId: string;
  userId: string;
  /** What the store's assistant may do now (the server decides; the card only mirrors it). */
  mode?: AssistantMode;
  onClose: () => void;
  onUnavailable: () => void;
}) {
  const t = useT('assistant');
  const locale = useLocale() === 'en' ? 'en' : 'ar';
  const [items, setItems] = useState<Item[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [off, setOff] = useState(false);
  const [rated, setRated] = useState<Record<string, 'up' | 'down'>>({});
  // One-time confirmation tokens, in memory only: never stored, never in the URL, gone on reload (the card then asks to be prepared again).
  const grants = useRef<Record<string, string>>({});
  const conv = useRef(conversationIdFor(storeId, userId));
  const panel = useRef<HTMLElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    void getConversation(storeId, conv.current).then(r => {
      if (alive && r.data)
        setItems(
          r.data.items.map(
            (x): Item =>
              x.role === 'merchant'
                ? { id: x.id, role: 'merchant', text: x.text }
                : { id: x.id, role: 'assistant', segments: [{ kind: 'text', text: x.text }] }
          )
        );
    });
    field.current?.focus();
    return () => {
      alive = false;
    };
  }, [storeId]);

  useEffect(() => {
    log.current?.scrollTo?.({ top: log.current.scrollHeight });
  }, [items, busy]);

  useEffect(() => {
    const el = panel.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const f = [
        ...el.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], textarea:not([disabled])'
        ),
      ];
      if (!f.length) return;
      const first = f[0]!;
      const last = f[f.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, [onClose]);

  const ask = useCallback(
    async (q: string) => {
      const clean = q.trim();
      if (!clean || busy) return;
      setFailed(null);
      setBusy(true);
      setItems(cur => [...cur, { id: crypto.randomUUID(), role: 'merchant', text: clean }]);
      setText('');
      const r = await postTurn(storeId, { conversationId: conv.current, text: clean, locale });
      setBusy(false);
      field.current?.focus();
      if (r.error || !r.data) return setFailed(clean);
      for (const g of r.data.approvals ?? []) grants.current[g.approvalId] = g.token;
      if (r.data.status === 'off') {
        setOff(true);
        return onUnavailable();
      }
      setItems(cur => [
        ...cur,
        {
          id: r.data!.turnId,
          role: 'assistant',
          segments: r.data!.segments,
          turnId: r.data!.turnId,
          status: r.data!.status,
          previews: r.data!.previews,
        },
      ]);
    },
    [busy, locale, onUnavailable, storeId]
  );

  const rate = (turnId: string, thumb: 'up' | 'down') => {
    if (rated[turnId]) return;
    setRated(r => ({ ...r, [turnId]: thumb }));
    void sendFeedback(storeId, turnId, thumb).then(res => {
      if (res.error)
        setRated(r => Object.fromEntries(Object.entries(r).filter(([k]) => k !== turnId)));
    });
  };
  const over = text.length > MAX;

  return (
    <section
      ref={panel}
      id="assistant-panel"
      role="dialog"
      aria-modal="false"
      aria-labelledby="assistant-title"
      data-testid="assistant-panel"
      className="fixed inset-y-0 end-0 z-50 flex w-full flex-col border-s border-border bg-background shadow-xl sm:w-[26rem]"
    >
      <header className="flex items-center gap-2 border-b border-border bg-card px-4 py-3">
        <h2 id="assistant-title" className="me-auto text-base font-semibold">
          {t('title')}
        </h2>
        {items.length > 0 && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              forgetConversation(storeId, userId);
              conv.current = conversationIdFor(storeId, userId);
              setItems([]);
              setFailed(null);
            }}
          >
            {t('newChat')}
          </Button>
        )}
        <Button type="button" variant="ghost" size="icon" aria-label={t('close')} onClick={onClose}>
          <X className="h-5 w-5" aria-hidden="true" />
        </Button>
      </header>

      <div
        ref={log}
        role="log"
        aria-live="polite"
        aria-label={t('log')}
        className="flex flex-1 flex-col gap-3 overflow-y-auto overscroll-contain p-4"
      >
        {off && (
          <p
            role="status"
            className="m-auto max-w-[36ch] text-center text-sm text-muted-foreground"
          >
            {t('off')}
          </p>
        )}
        {!off && items.length === 0 && (
          <div className="m-auto grid gap-2 text-center">
            <p className="text-base font-medium">{t('emptyTitle')}</p>
            <p className="text-sm text-muted-foreground">
              {t(mode === 'answer-only' ? 'intro' : 'introDo')}
            </p>
            <ul className="mt-2 grid list-none justify-items-center gap-2 p-0">
              {(['s1', 's2', 's3'] as const).map(k => (
                <li key={k}>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void ask(t(`suggestions.${k}`))}
                  >
                    {t(`suggestions.${k}`)}
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {items.map(m =>
          m.role === 'merchant' ? (
            <div
              key={m.id}
              className="max-w-[92%] self-end rounded-lg bg-muted px-3.5 py-2 text-sm"
            >
              <span className="sr-only">{t('you')}: </span>
              <p dir="auto" className="whitespace-pre-wrap break-words">
                {m.text}
              </p>
            </div>
          ) : (
            <div
              key={m.id}
              data-status={m.status}
              className="max-w-[92%] self-start rounded-lg border border-border bg-card px-3.5 py-2.5 text-sm"
            >
              <span className="sr-only">{t('title')}: </span>
              <p className="whitespace-pre-wrap break-words leading-relaxed">
                <Segments segments={m.segments} storeId={storeId} onNavigate={() => undefined} />
              </p>
              {m.previews?.map(c =>
                c.policy === 'confirm' ? (
                  <ConfirmCard
                    key={c.previewId}
                    card={c}
                    token={c.approvalId ? grants.current[c.approvalId] : undefined}
                    onConfirm={(id, tok) => confirmApproval(storeId, id, tok, locale)}
                    onReject={id => rejectApproval(storeId, id, locale)}
                    onUndo={id => undoApplied(storeId, id, locale)}
                    onFresh={(id, tok) => {
                      grants.current[id] = tok;
                    }}
                  />
                ) : (
                  <PreviewCard
                    key={c.previewId}
                    card={c}
                    mode={mode}
                    onApply={id => applyPreview(storeId, id, locale)}
                    onUndo={id => undoApplied(storeId, id, locale)}
                  />
                )
              )}
              {m.turnId && m.status === 'answered' && (
                <div
                  role="group"
                  aria-label={t('rateGroup')}
                  className="mt-1 flex items-center gap-1"
                >
                  {rated[m.turnId] ? (
                    <span role="status" className="text-xs text-muted-foreground">
                      {t('thanks')}
                    </span>
                  ) : (
                    <>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t('thumbUp')}
                        onClick={() => rate(m.turnId!, 'up')}
                      >
                        <ThumbsUp className="h-4 w-4" aria-hidden="true" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t('thumbDown')}
                        onClick={() => rate(m.turnId!, 'down')}
                      >
                        <ThumbsDown className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    </>
                  )}
                </div>
              )}
            </div>
          )
        )}
        {busy && (
          <div
            role="status"
            className="flex items-center gap-2 self-start text-sm text-muted-foreground"
          >
            <span aria-hidden="true" className="inline-flex gap-1 motion-reduce:hidden">
              <i className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
              <i className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary [animation-delay:150ms]" />
              <i className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary [animation-delay:300ms]" />
            </span>
            <span>{t('thinking')}</span>
          </div>
        )}
        {failed !== null && (
          <div
            role="alert"
            className="flex flex-col items-center gap-2 rounded-md border border-border bg-card p-3 text-center text-sm text-muted-foreground"
          >
            <CircleAlert className="h-5 w-5" aria-hidden="true" />
            <p>{t('error')}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                const q = failed;
                setItems(cur => cur.slice(0, -1));
                void ask(q);
              }}
            >
              {t('retry')}
            </Button>
          </div>
        )}
      </div>

      <form
        className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 border-t border-border bg-card p-3"
        onSubmit={e => {
          e.preventDefault();
          void ask(text);
        }}
      >
        <label htmlFor="assistant-input" className="sr-only">
          {t('placeholder')}
        </label>
        <textarea
          id="assistant-input"
          ref={field}
          rows={2}
          dir="auto"
          value={text}
          disabled={off}
          placeholder={t('placeholder')}
          aria-describedby="assistant-count"
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void ask(text);
            }
          }}
          className={`${TEXTAREA_CLASSES} max-h-36 resize-none`}
        />
        <Button
          type="submit"
          size="icon"
          aria-label={t('send')}
          disabled={busy || off || !text.trim() || over}
          className="self-end"
        >
          <ArrowUp className="h-[18px] w-[18px]" aria-hidden="true" />
        </Button>
        <span
          id="assistant-count"
          className={`col-span-2 text-xs ${over ? 'text-destructive-ink' : 'text-muted-foreground'}`}
        >
          {over ? t('tooLong') : t('hint')}
        </span>
      </form>
    </section>
  );
}
