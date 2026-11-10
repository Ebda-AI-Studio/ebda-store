'use client';

/**
 * Media picker on the EXISTING upload API: browse the store's own images
 * (`GET /uploads/list`, tenant-scoped R2 prefix) or upload a new one into
 * `stores/<storeId>/builder/` (`POST /uploads/image`, the same pipeline,
 * resize and audit as every other admin upload). Images are served from the
 * bucket's public URL (Ebda: STORAGE_BUCKET=ebda-media,
 * STORAGE_PUBLIC_URL=https://media.ebda.app).
 */
import { Button } from '@/components/ui/Button';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '@/i18n/useT';
import { apiGet } from '../../../../../lib/api';
import { useImageUpload } from '../../../../../hooks/useImageUpload';
import { useRestoreFocus } from '../_lib/use-restore-focus';

interface MediaItem {
  key: string;
  url: string;
  size: number;
  lastModified: string | null;
}

export function MediaPicker({
  storeId,
  onPick,
  onClose,
  hint,
}: {
  storeId: string;
  onPick: (url: string) => void;
  onClose: () => void;
  /** One line under the title, e.g. the recommended size for this picture. */
  hint?: string;
}) {
  const t = useT('builder.media');
  const ref = useRef<HTMLDialogElement>(null);
  useRestoreFocus();
  const [items, setItems] = useState<MediaItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const { uploadSingle, uploading, error: uploadError } = useImageUpload();

  const load = useCallback(
    async (after?: string) => {
      setState('loading');
      const q = new URLSearchParams({ storeId });
      if (after) q.set('cursor', after);
      const res = await apiGet<{ items: MediaItem[]; nextCursor: string | null }>(
        `/api/v1/uploads/list?${q.toString()}`
      );
      if (res.error || !res.data) return setState('error');
      setItems(prev => (after ? [...prev, ...res.data!.items] : res.data!.items));
      setCursor(res.data.nextCursor);
      setState('ready');
    },
    [storeId]
  );

  useEffect(() => {
    ref.current?.showModal();
    void load();
  }, [load]);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    const url = await uploadSingle(file, 'builder', storeId);
    if (url) onPick(url);
  };

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={onClose}
      aria-labelledby="media-title"
      className="w-[min(48rem,calc(100vw-2rem))] rounded-2xl border border-border bg-card p-0 text-foreground backdrop:bg-black/60"
      data-testid="media-picker"
    >
      <div className="flex items-center justify-between gap-2 border-b border-border px-5 py-3">
        <h2 id="media-title" className="text-base font-semibold">
          {t('title')}
        </h2>
        <div className="flex items-center gap-2">
          <label className="cursor-pointer rounded-lg bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90">
            {uploading ? t('uploading') : t('upload')}
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              className="sr-only"
              disabled={uploading}
              onChange={e => void onFile(e.target.files?.[0])}
            />
          </label>
          <Button variant="ghost" size="sm" type="button" onClick={onClose}>
            {t('close')}
          </Button>
        </div>
      </div>
      {hint && (
        <p className="px-5 pt-3 text-xs text-muted-foreground" data-testid="media-hint">
          {hint}
        </p>
      )}
      {uploadError && (
        <p role="alert" className="px-5 pt-3 text-sm text-destructive-ink">
          {uploadError}
        </p>
      )}
      <div className="max-h-[60vh] overflow-y-auto p-5">
        {state === 'error' && <p className="text-sm text-destructive-ink">{t('loadError')}</p>}
        {state !== 'error' && items.length === 0 && state === 'ready' && (
          <p className="text-sm text-muted-foreground">{t('empty')}</p>
        )}
        <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {items.map((it, i) => (
            <li key={it.key}>
              <button
                data-ui="tile"
                type="button"
                onClick={() => onPick(it.url)}
                // The thumbnail is decorative (alt=""), so without this the button has no name.
                aria-label={t('pickImage', { n: i + 1, name: it.key.split('/').pop() ?? '' })}
                className="block w-full overflow-hidden rounded-lg border border-border hover:border-primary"
              >
                {}
                <img
                  src={it.url}
                  alt=""
                  loading="lazy"
                  className="aspect-square w-full object-cover"
                />
              </button>
            </li>
          ))}
        </ul>
        {cursor && (
          <Button
            variant="outline"
            size="sm"
            type="button"
            onClick={() => void load(cursor)}
            className="mt-3"
          >
            {t('more')}
          </Button>
        )}
        {state === 'loading' && (
          <p className="mt-3 text-sm text-muted-foreground">{t('loading')}</p>
        )}
      </div>
    </dialog>
  );
}
