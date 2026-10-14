'use client';

/**
 * Builder `video` setting: upload one mp4/webm (<= 6 MB) to
 * `stores/<storeId>/builder/` via `POST /uploads/video`, preview it muted and
 * looping with a size readout, or remove it. The size and type are checked
 * here first so a 40 MB file never leaves the browser; the API enforces the
 * same limits and sniffs the bytes.
 */
import { useEffect, useRef, useState } from 'react';
import { useT } from '@/i18n/useT';
import { useImageUpload } from '@/hooks/useImageUpload';
import { VIDEO_ACCEPT, checkVideoFile, formatMegabytes } from '@/lib/video-upload';

export function VideoField({
  storeId,
  tag,
  value,
  onChange,
}: {
  storeId: string;
  tag: string;
  value: string;
  onChange: (v: string | undefined) => void;
}) {
  const t = useT('builder.settings');
  const { uploadVideo, uploading, error: uploadError } = useImageUpload();
  const inputRef = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [bytes, setBytes] = useState<number | null>(null);
  // Reduced motion: no autoplay, show the first frame with controls instead.
  const [reduceMotion, setReduceMotion] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!mq) return;
    setReduceMotion(mq.matches);
    const on = (e: MediaQueryListEvent) => setReduceMotion(e.matches);
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    const check = checkVideoFile(file);
    if (check !== 'ok') {
      setProblem(check === 'too-large' ? t('videoTooLarge') : t('videoBadType'));
      return;
    }
    setProblem(null);
    const url = await uploadVideo(file, 'builder', storeId);
    if (url) {
      setBytes(file.size);
      onChange(url);
    }
  };

  const message = problem ?? uploadError;
  return (
    <div className="min-w-0">
      {tag && <span className="mb-0.5 block text-[11px] text-muted-foreground">{tag}</span>}
      <div className="flex items-center gap-2">
        {value ? (
          <video
            src={value}
            muted
            loop
            autoPlay={!reduceMotion}
            controls={reduceMotion}
            playsInline
            preload="metadata"
            className="h-12 w-20 rounded-md border border-border object-cover"
            data-testid="video-preview"
          />
        ) : (
          <span
            className="h-12 w-20 rounded-md border border-dashed border-border"
            aria-hidden="true"
          />
        )}
        <div className="flex flex-col items-start gap-0.5">
          <button
            type="button"
            disabled={uploading}
            onClick={() => inputRef.current?.click()}
            className="text-xs font-medium text-primary hover:underline disabled:opacity-50"
          >
            {uploading ? t('videoUploading') : value ? t('changeVideo') : t('chooseVideo')}
          </button>
          {value && bytes !== null && (
            <span className="text-[11px] text-muted-foreground" data-testid="video-size">
              {t('videoSize', { size: formatMegabytes(bytes) })}
            </span>
          )}
          {value && (
            <button
              type="button"
              onClick={() => {
                setBytes(null);
                setProblem(null);
                onChange(undefined);
              }}
              className="text-xs text-muted-foreground hover:underline"
            >
              {t('removeVideo')}
            </button>
          )}
        </div>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={VIDEO_ACCEPT}
        className="hidden"
        data-testid="video-file-input"
        onChange={e => {
          const f = e.target.files?.[0];
          e.target.value = '';
          void pick(f);
        }}
      />
      {!value && !message && (
        <p className="mt-1 text-[11px] text-muted-foreground">{t('videoHint')}</p>
      )}
      {message && (
        <p role="alert" className="mt-1 text-[11px] text-destructive-ink">
          {message}
        </p>
      )}
    </div>
  );
}
