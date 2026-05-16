'use client';

import { useCallback, useState } from 'react';
import { useT } from '@/i18n/useT';
import { useImageUpload } from '../hooks/useImageUpload';
import { apiDelete } from '../lib/api';
import { UploadDropzone } from './image-upload/UploadDropzone';
import { UploadPreview } from './image-upload/UploadPreview';
import { UploadProgress } from './image-upload/UploadProgress';
import { MultiImageGrid } from './image-upload/MultiImageGrid';

/**
 * Extract the R2 object key from a stored URL. Both the public CDN URL
 * (`*.r2.dev/<key>`) and the legacy r2.cloudflarestorage.com hostname are
 * handled. Returns null when the URL doesn't match a known R2 pattern
 * (e.g. external image URLs from a different bucket — we shouldn't try
 * to delete those).
 */
function extractR2Key(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    // r2.dev pattern: <bucket>.r2.dev/<key> — key is the full path
    if (u.hostname.endsWith('.r2.dev')) {
      return u.pathname.replace(/^\/+/, '') || null;
    }
    // r2.cloudflarestorage.com pattern: <accountId>.r2.cloudflarestorage.com/<bucket>/<key>
    // first path segment is the bucket name; key = rest
    if (u.hostname.endsWith('.r2.cloudflarestorage.com')) {
      const parts = u.pathname.replace(/^\/+/, '').split('/');
      return parts.slice(1).join('/') || null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Call the API to delete the underlying R2 object. Fire-and-forget by
 * design — if the delete fails we DON'T block the merchant's UI flow
 * because the local state (image cleared from the form) is what matters
 * for their workflow. Worst case is orphan R2 object that the per-store
 * r2-cleanup cron will sweep later. Errors logged to console only.
 */
async function deleteR2Object(url: string | undefined | null): Promise<void> {
  const key = extractR2Key(url);
  if (!key) return;
  try {
    await apiDelete(`/api/v1/uploads/${key}`);
  } catch (err) {
    console.warn('[ImageUpload] R2 delete failed (orphan will be swept later):', err);
  }
}

interface ImageUploadProps {
  value?: string;
  onUpload: (url: string) => void;
  onRemove?: () => void;
  /**
   * Asset folder hint. Must be one of the API's whitelisted folders:
   * `logos`, `products`, `categories`, `pages`, `branding`, `hero`, `misc`.
   * The API composes the final R2 key as `stores/<storeId>/<folder>/...`
   * when `storeId` is also supplied — do NOT bake `stores/...` into this
   * value, that double-prefixes.
   */
  folder?: string;
  /**
   * Tenant scope. When provided, uploads land under
   * `stores/<storeId>/<folder>/...` in R2. When omitted, the API falls
   * back to the legacy flat key shape (used for platform/super_admin
   * uploads).
   */
  storeId?: string;
  label?: string;
  accept?: string;
  className?: string;
  /**
   * Visual aspect ratio for the upload preview, matching the storefront
   * render. When set, both the empty dropzone AND the post-upload preview
   * render at this ratio so the merchant sees exactly how their image
   * will be cropped on the storefront. Values mirror the storefront
   * aspects per docs/superpowers/plans/2026-05-16-mobile-ui-ship.md:
   *   - '3/2'  → hero banner (recommend 1200×800)
   *   - '1/1'  → category tile + product image (recommend 800×800 / 1000×1000)
   *   - 'free' → no aspect lock (default, legacy behavior)
   */
  aspectRatio?: '3/2' | '1/1' | 'free';
  /**
   * Optional recommended-dimensions hint shown under the dropzone, e.g.
   * "Recommended: 1200×800px (3:2 landscape)". Caller composes the
   * localized string; this just renders it.
   */
  recommendedSizeHint?: string;
}

interface MultiImageUploadProps {
  values: string[];
  onChange: (urls: string[]) => void;
  /** See {@link ImageUploadProps.folder}. */
  folder?: string;
  /** See {@link ImageUploadProps.storeId}. */
  storeId?: string;
  label?: string;
  max?: number;
  className?: string;
}

const MAX_FILE_SIZE = 10 * 1024 * 1024;

export function ImageUpload({
  value,
  onUpload,
  onRemove,
  folder = 'products',
  storeId,
  label,
  accept = 'image/jpeg,image/png,image/webp,image/gif',
  className = '',
  aspectRatio = 'free',
  recommendedSizeHint,
}: ImageUploadProps) {
  // Map aspect ratio to a Tailwind class. Used on both the empty dropzone
  // and the post-upload preview so the merchant sees the same rectangle
  // shape the storefront will render in.
  const aspectClass =
    aspectRatio === '3/2' ? 'aspect-[3/2]' : aspectRatio === '1/1' ? 'aspect-square' : '';
  const t = useT('components.imageUpload');
  const resolvedLabel = label ?? t('label');
  const { uploading, progress, error, setError, uploadSingle } = useImageUpload();
  const [localError, setLocalError] = useState<string | null>(null);

  const handleFiles = useCallback(
    async (fileList: FileList) => {
      const file = fileList[0];
      if (!file) return;

      const acceptTypes = accept.split(',').map(a => a.trim());
      const typeOk = acceptTypes.some(
        tp => file.type === tp || (tp.endsWith('/*') && file.type.startsWith(tp.replace('/*', '/')))
      );
      if (!typeOk) {
        setLocalError(t('errors.typeNotAccepted', { type: file.type }));
        return;
      }
      if (file.size > MAX_FILE_SIZE) {
        setLocalError(t('errors.tooLarge'));
        return;
      }

      setLocalError(null);
      setError(null);
      const url = await uploadSingle(file, folder, storeId);
      if (url) onUpload(url);
    },
    [accept, folder, onUpload, setError, storeId, t, uploadSingle]
  );

  // Wrap the caller's onRemove so we ALSO delete the R2 object server-side
  // (per ahmad's 2026-05-16 ask: 'r2 must be bidirectional — if i delete
  // from admin it's deleted from storage'). The delete fires before the
  // local state clears so it happens against the still-current URL.
  // fire-and-forget — caller's onRemove runs regardless of network state.
  const handleRemoveWithR2 = useCallback(() => {
    void deleteR2Object(value);
    onRemove?.();
  }, [value, onRemove]);

  if (value) {
    return (
      <div className={className}>
        <div className={aspectClass}>
          <UploadPreview value={value} alt={resolvedLabel} onRemove={handleRemoveWithR2} />
        </div>
        {recommendedSizeHint && (
          <p className="mt-2 text-xs text-muted-foreground">{recommendedSizeHint}</p>
        )}
      </div>
    );
  }

  const displayError = localError ?? error;

  return (
    <div className={className}>
      <div className={aspectClass}>
        <UploadDropzone accept={accept} onFiles={handleFiles} paddingClass="p-6">
          {uploading ? (
            <UploadProgress
              progress={progress}
              label={t('uploadingPercent', { progress })}
              trackWidthClass="w-32"
            />
          ) : (
            <>
              <svg
                className="mx-auto h-10 w-10 text-muted-foreground"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
                />
              </svg>
              <p className="mt-1 text-sm text-muted-foreground">{resolvedLabel}</p>
              <p className="text-xs text-muted-foreground">{t('browse')}</p>
            </>
          )}
        </UploadDropzone>
      </div>
      {recommendedSizeHint && (
        <p className="mt-2 text-xs text-muted-foreground">{recommendedSizeHint}</p>
      )}

      {displayError && <p className="mt-1 text-xs text-destructive">{displayError}</p>}
    </div>
  );
}

export function MultiImageUpload({
  values,
  onChange,
  folder = 'products',
  storeId,
  label,
  max = 10,
  className = '',
}: MultiImageUploadProps) {
  const t = useT('components.imageUpload');
  const resolvedLabel = label ?? t('multiLabel');
  const { uploading, progress, error, setError, uploadMulti } = useImageUpload();
  const [localError, setLocalError] = useState<string | null>(null);

  const handleFiles = useCallback(
    async (fileList: FileList) => {
      const remaining = max - values.length;
      if (remaining <= 0) {
        setLocalError(t('errors.maxReached', { max }));
        return;
      }

      const files = Array.from(fileList)
        .filter(f => f.type.startsWith('image/') && f.size <= MAX_FILE_SIZE)
        .slice(0, remaining);
      if (files.length === 0) {
        setLocalError(t('errors.noValidFiles'));
        return;
      }

      setLocalError(null);
      setError(null);
      const newUrls = await uploadMulti(files, folder, storeId);
      if (newUrls) onChange([...values, ...newUrls]);
    },
    [folder, max, onChange, setError, storeId, t, uploadMulti, values]
  );

  const removeImage = useCallback(
    (index: number) => {
      // Bidirectional delete — same posture as ImageUpload.handleRemoveWithR2.
      // Fires R2 delete before local state clear; local always wins on UI.
      void deleteR2Object(values[index]);
      onChange(values.filter((_, i) => i !== index));
    },
    [onChange, values]
  );

  const moveImage = useCallback(
    (from: number, to: number) => {
      if (to < 0 || to >= values.length) return;
      const next = [...values];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      onChange(next);
    },
    [onChange, values]
  );

  const displayError = localError ?? error;

  return (
    <div className={className}>
      <MultiImageGrid values={values} onMove={moveImage} onRemove={removeImage} />

      {values.length < max && (
        <UploadDropzone
          accept="image/jpeg,image/png,image/webp,image/gif"
          multiple
          onFiles={handleFiles}
          paddingClass="p-8"
        >
          {uploading ? (
            <UploadProgress
              progress={progress}
              label={t('uploadingMulti', { progress })}
              trackWidthClass="w-40"
            />
          ) : (
            <>
              <svg
                className="mx-auto h-12 w-12 text-muted-foreground"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
                />
              </svg>
              <p className="mt-2 text-sm text-muted-foreground">{resolvedLabel}</p>
              <p className="text-xs text-muted-foreground">
                {t('browseMulti', { count: values.length, max })}
              </p>
            </>
          )}
        </UploadDropzone>
      )}

      {displayError && <p className="mt-1 text-xs text-destructive">{displayError}</p>}
    </div>
  );
}
