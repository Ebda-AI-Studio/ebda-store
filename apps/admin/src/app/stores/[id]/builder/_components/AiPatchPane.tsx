'use client';

/**
 * Ask AI to edit the page (builder Phase 5). The merchant types a plain request; the server answers with a
 * STRUCTURED, validated patch. The proposed page renders in the same canvas (over the merchant's own
 * content) and this pane lists exactly what changes, before and after. Nothing is saved until Apply, and
 * Apply only writes the DRAFT (Undo works, nothing goes live before Publish).
 */
import { Button } from '@/components/ui/Button';
import { useRef, useState } from 'react';
import { useLocale } from 'next-intl';
import { useT } from '@/i18n/useT';
import { AiChangeValue } from './AiChangeValue';

export interface AiPatchChangeRow {
  op: string;
  id?: string;
  key?: string;
  before?: unknown;
  after?: unknown;
  labelEn: string;
  labelAr: string;
}

export interface AiPatchProposal {
  baseRev: number;
  summaryEn: string;
  summaryAr: string;
  ops: unknown[];
  changes: AiPatchChangeRow[];
  rejected: Array<{ index: number; reason: string }>;
}

export function AiPatchPane({
  busy,
  proposal,
  error,
  onAsk,
  onApply,
  onDiscard,
}: {
  busy: 'ask' | 'apply' | null;
  proposal: AiPatchProposal | null;
  error: string | null;
  onAsk: (instruction: string) => void;
  onApply: () => void;
  onDiscard: () => void;
}) {
  const t = useT('builder.aiPatch');
  const locale = useLocale() === 'ar' ? 'ar' : 'en';
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const kept = proposal?.rejected.filter(r => r.reason === 'OVERWRITE_PROTECTED').length ?? 0;

  return (
    <div
      className="flex h-full flex-col"
      data-testid="ai-patch-pane"
      data-setting-id="builder.ai-patch"
    >
      <div className="border-b border-border px-4 py-3">
        <h2 id="ai-patch-title" className="text-sm font-semibold">
          {t('title')}
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">{t('intro')}</p>
      </div>
      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {proposal ? (
          <section aria-label={t('changesTitle')} className="space-y-3 text-sm">
            {proposal.changes.length > 0 && (
              <p className="font-medium">
                {locale === 'ar' ? proposal.summaryAr : proposal.summaryEn}
              </p>
            )}
            {proposal.changes.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t('none')}</p>
            ) : (
              <>
                <h3 className="text-xs font-semibold text-muted-foreground">{t('changesTitle')}</h3>
                <ul className="space-y-2">
                  {proposal.changes.map((c, i) => (
                    <li key={i} className="rounded-lg border border-border p-2 text-xs">
                      <span className="block font-medium">
                        {locale === 'ar' ? c.labelAr : c.labelEn}
                      </span>
                      {c.op === 'setSectionSetting' ||
                      c.op === 'setBlockSetting' ||
                      c.op === 'setTheme' ||
                      c.op === 'setSectionHidden' ||
                      c.op === 'setRef' ||
                      c.op === 'setViewportSetting' ||
                      c.op === 'setViewportHidden' ? (
                        <span className="mt-1 flex flex-wrap items-center gap-1 text-muted-foreground">
                          <span>{t('from')}</span>
                          <span className="rounded bg-muted px-1 line-through decoration-muted-foreground/60">
                            <AiChangeValue value={c.before} op={c.op} field={c.key} t={t} />
                          </span>
                          <span>{t('to')}</span>
                          <span className="rounded bg-primary/15 px-1 text-foreground">
                            <AiChangeValue value={c.after} op={c.op} field={c.key} t={t} />
                          </span>
                        </span>
                      ) : (
                        <span className="mt-1 block text-muted-foreground">
                          {c.op === 'addSection'
                            ? t('added')
                            : c.op === 'removeSection'
                              ? t('removed')
                              : c.op === 'addBlock'
                                ? t('added_block')
                                : c.op === 'removeBlock'
                                  ? t('removed_block')
                                  : c.op === 'moveBlock'
                                    ? t('moved_block', { pos: Number(c.after ?? 0) + 1 })
                                    : t('moved_to', { pos: Number(c.after ?? 0) + 1 })}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {kept > 0 && (
              <p className="text-xs text-muted-foreground">{t('kept', { count: kept })}</p>
            )}
            {proposal.rejected.length - kept > 0 && (
              <p className="text-xs text-muted-foreground">
                {t('skipped', { count: proposal.rejected.length - kept })}
              </p>
            )}
            {proposal.changes.length > 0 && (
              <p className="text-xs text-muted-foreground">{t('draftNote')}</p>
            )}
            <div className="flex gap-2 pt-1">
              {proposal.changes.length > 0 && (
                <Button
                  size="sm"
                  type="button"
                  onClick={onApply}
                  disabled={busy !== null}
                  className="font-semibold"
                  data-testid="ai-patch-apply"
                >
                  {busy === 'apply' ? t('applying') : t('apply')}
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                type="button"
                onClick={onDiscard}
                disabled={busy !== null}
                data-testid="ai-patch-discard"
              >
                {t('discard')}
              </Button>
            </div>
          </section>
        ) : (
          <>
            <textarea
              id="ai-patch-input"
              ref={inputRef}
              aria-labelledby="ai-patch-title"
              dir="auto"
              rows={4}
              maxLength={500}
              value={text}
              onChange={e => setText(e.target.value)}
              placeholder={t('placeholder')}
              disabled={busy !== null}
              className="w-full rounded-lg border border-border bg-background p-2 text-sm"
            />
            <div className="flex flex-wrap gap-2">
              {(['example1', 'example2', 'example3', 'example4'] as const).map(k => (
                <Button
                  variant="outline"
                  size="sm"
                  key={k}
                  type="button"
                  onClick={() => {
                    const v = t(k);
                    setText(v);
                    const el = inputRef.current;
                    if (el) {
                      el.value = v;
                      el.focus();
                      el.setSelectionRange(v.length, v.length);
                    }
                  }}
                >
                  {t(k)}
                </Button>
              ))}
            </div>
            {error && (
              <p role="alert" className="text-xs text-destructive-ink">
                {error}
              </p>
            )}
            <Button
              size="sm"
              type="button"
              onClick={() => {
                const v = text.trim();
                if (v.length >= 2) onAsk(v);
              }}
              disabled={busy !== null}
              className="font-semibold"
              data-testid="ai-patch-ask"
            >
              {busy === 'ask' ? t('asking') : t('ask')}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
