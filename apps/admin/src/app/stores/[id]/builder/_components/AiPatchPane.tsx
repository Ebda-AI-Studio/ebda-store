'use client';

/**
 * Ask AI to edit the page (builder Phase 5). The merchant types a plain request; the server answers with a
 * STRUCTURED, validated patch. The proposed page renders in the same canvas (over the merchant's own
 * content) and this pane lists exactly what changes, before and after. Nothing is saved until Apply, and
 * Apply only writes the DRAFT (Undo works, nothing goes live before Publish).
 */
import { Button } from '@/components/ui/Button';
import { useState } from 'react';
import { useLocale } from 'next-intl';
import { useT } from '@/i18n/useT';
import { TEXTAREA_CLASSES } from '@/components/ui/tokens';

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

/** A boolean means "hidden" for a hide/show change and "on" for a switch setting. */
function show(
  v: unknown,
  op: string,
  t: (k: string, p?: Record<string, string | number>) => string
): string {
  if (v === undefined || v === null || v === '') return '-';
  if (typeof v === 'boolean')
    return op === 'setSectionHidden' ? t(v ? 'hidden' : 'shown') : t(v ? 'on' : 'off');
  return String(v);
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
                      c.op === 'setSectionHidden' ? (
                        <span className="mt-1 flex flex-wrap items-center gap-1 text-muted-foreground">
                          <span>{t('from')}</span>
                          <bdi className="rounded bg-muted px-1 line-through decoration-muted-foreground/60">
                            {show(c.before, c.op, t)}
                          </bdi>
                          <span>{t('to')}</span>
                          <bdi className="rounded bg-primary/15 px-1 text-foreground">
                            {show(c.after, c.op, t)}
                          </bdi>
                        </span>
                      ) : (
                        <span className="mt-1 block text-muted-foreground">
                          {c.op === 'addSection'
                            ? t('added')
                            : c.op === 'removeSection'
                              ? t('removed')
                              : t('moved_to', { pos: Number(c.after ?? 0) + 1 })}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {proposal.rejected.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {t('skipped', { count: proposal.rejected.length })}
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
              aria-labelledby="ai-patch-title"
              dir="auto"
              rows={4}
              maxLength={500}
              value={text}
              onChange={e => setText(e.target.value)}
              placeholder={t('placeholder')}
              disabled={busy !== null}
              className={TEXTAREA_CLASSES}
            />
            <div className="flex flex-wrap gap-2">
              {(['example1', 'example2'] as const).map(k => (
                <Button
                  variant="outline"
                  size="sm"
                  key={k}
                  type="button"
                  onClick={() => setText(t(k))}
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
