'use client';

/**
 * Builder `video` setting: upload one mp4/webm (<= 6 MB) to
 * `stores/<storeId>/builder/` via `POST /uploads/video`, preview it muted and
 * looping with a size readout, or remove it. The size and type are checked
 * here first so a 40 MB file never leaves the browser; the API enforces the
 * same limits and sniffs the bytes.
 */
import { Button } from '@/components/ui/Button';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useT } from '@/i18n/useT';
import { useImageUpload } from '@/hooks/useImageUpload';
import { VIDEO_ACCEPT, checkVideoFile, formatMegabytes } from '@/lib/video-upload';

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

function readReducedMotion(): boolean {
  try {
    return window.matchMedia?.(REDUCED_MOTION)?.matches ?? false;
  } catch {
    return false;
  }
}

function subscribeReducedMotion(onChange: () => void): () => void {
  const mq = typeof window === 'undefined' ? undefined : window.matchMedia?.(REDUCED_MOTION);
  if (!mq) return () => undefined;
  mq.addEventListener?.('change', onChange);
  return () => mq.removeEventListener?.('change', onChange);
}

const serverReducedMotion = () => false;

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
  // Reduced motion: no autoplay, show the first frame with controls instead. A store, not
  // render-time `window` access: the server render (and hydration) uses `false`, a client-only
  // render reads the real value on its FIRST render, and a hydrated page re-renders with the
  // real value, so nothing reads `window` where there is none and there is no hydration mismatch.
  const reduceMotion = useSyncExternalStore(
    subscribeReducedMotion,
    readReducedMotion,
    serverReducedMotion
  );
  // Removing `autoplay` does not stop a video the browser already started while parsing
  // server markup, so pause it explicitly once reduced motion is known.
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (reduceMotion) videoRef.current?.pause();
  }, [reduceMotion, value]);

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
    <div className="min-w-0" data-setting-id="builder.video">
      {tag && <span className="mb-0.5 block text-xs text-muted-foreground">{tag}</span>}
      <div className="flex items-center gap-2">
        {value ? (
          <video
            ref={videoRef}
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
          <Button
            variant="link"
            size="sm"
            type="button"
            disabled={uploading}
            onClick={() => inputRef.current?.click()}
          >
            {uploading ? t('videoUploading') : value ? t('changeVideo') : t('chooseVideo')}
          </Button>
          {value && bytes !== null && (
            <span className="text-xs text-muted-foreground" data-testid="video-size">
              {t('videoSize', { size: formatMegabytes(bytes) })}
            </span>
          )}
          {value && (
            <Button
              variant="ghost"
              size="sm"
              type="button"
              onClick={() => {
                setBytes(null);
                setProblem(null);
                onChange(undefined);
              }}
              className="text-muted-foreground"
            >
              {t('removeVideo')}
            </Button>
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
      {!value && !message && <p className="mt-1 text-xs text-muted-foreground">{t('videoHint')}</p>}
      {message && (
        <p role="alert" className="mt-1 text-xs text-destructive-ink">
          {message}
        </p>
      )}
    </div>
  );
}
