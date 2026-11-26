'use client';

/**
 * "Change image" from the canvas (Task 3). The canvas only NAMED the target;
 * the file is chosen here, from the store's own media (`MediaPicker` on the
 * tenant-scoped upload API). Pick, then (when the setting has an alt sibling)
 * a short description in Arabic and English, then one undoable commit.
 */
import { Button } from '@/components/ui/Button';
import { useState } from 'react';
import { useT } from '@/i18n/useT';
import { MediaPicker } from './MediaPicker';
import { useRestoreFocus } from '../_lib/use-restore-focus';
import { FIELD_CLASSES } from '@/components/ui/tokens';

export interface SwapRequest {
  alt?: { en: string; ar?: string };
}

export function ImageSwapDialog({
  storeId,
  request,
  hint,
  onApply,
  onClose,
}: {
  storeId: string;
  request: SwapRequest;
  hint?: string;
  onApply: (url: string, alt?: { en?: string; ar?: string }) => void;
  onClose: () => void;
}) {
  const t = useT('builder.media');
  useRestoreFocus();
  const [picked, setPicked] = useState<string | null>(null);
  const [en, setEn] = useState(request.alt?.en ?? '');
  const [ar, setAr] = useState(request.alt?.ar ?? '');

  if (!picked)
    return (
      <MediaPicker
        storeId={storeId}
        hint={hint}
        onClose={onClose}
        onPick={url => {
          // No alt sibling: the swap is done.
          if (!request.alt) return onApply(url);
          setPicked(url);
        }}
      />
    );

  return (
    <dialog
      ref={el => {
        if (el && !el.open) el.showModal();
      }}
      onClose={onClose}
      onCancel={onClose}
      aria-labelledby="swap-alt-title"
      className="w-[min(30rem,calc(100vw-2rem))] rounded-lg border border-border bg-card p-0 text-foreground backdrop:bg-black/60"
      data-testid="image-swap-alt"
    >
      <form
        method="dialog"
        className="space-y-3 p-5"
        onSubmit={e => {
          e.preventDefault();
          onApply(picked, {
            en,
            ...(request.alt?.ar !== undefined ? { ar } : {}),
          });
        }}
      >
        <h2 id="swap-alt-title" className="text-base font-semibold">
          {t('altTitle')}
        </h2>
        <img src={picked} alt="" className="aspect-video w-full rounded-lg object-cover" />
        <p className="text-xs text-muted-foreground">{t('altHint')}</p>
        {request.alt?.ar !== undefined && (
          <label className="block text-sm">
            {t('altAr')}
            <input
              dir="rtl"
              lang="ar"
              value={ar}
              maxLength={300}
              onChange={e => setAr(e.target.value)}
              data-testid="swap-alt-ar"
              className={`${FIELD_CLASSES} mt-1`}
            />
          </label>
        )}
        <label className="block text-sm">
          {t('altEn')}
          <input
            dir="ltr"
            lang="en"
            value={en}
            maxLength={300}
            onChange={e => setEn(e.target.value)}
            data-testid="swap-alt-en"
            className={`${FIELD_CLASSES} mt-1`}
          />
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" type="button" onClick={() => setPicked(null)}>
            {t('altBack')}
          </Button>
          <Button type="submit" data-testid="swap-apply" className="font-semibold">
            {t('altApply')}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
