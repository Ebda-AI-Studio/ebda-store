'use client';

import { useCallback, useState } from 'react';
import { getApiUrl, localizedApiMessage } from '../lib/api';
import { useT } from '@/i18n/useT';
import { IMAGE_UPLOAD_BATCH_MAX } from '@ebda/shared';

type Translator = ReturnType<typeof useT>;

/** Split `items` into consecutive groups of at most `size`, preserving order. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * The API's error text for a failed upload in the admin's language (a byte-sniff refusal
 * carries `details.messageEn` / `details.messageAr`), else its message, else `fallback`.
 */
export function uploadErrorText(data: UploadResponse | undefined, fallback: string): string {
  const err = data?.error;
  return localizedApiMessage(err?.code, err?.message || fallback, err?.details);
}

/**
 * Shared upload helpers for the ImageUpload widgets. Extracted so the
 * single- and multi-image variants don't duplicate XHR/progress logic.
 */
export function useImageUpload() {
  const t = useT('components.imageUpload');
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  /**
   * Build the upload URL with the folder hint and (optional) tenant scope.
   * The API composes the final R2 key as `stores/<storeId>/<folder>/...`
   * when a `storeId` is supplied, otherwise it falls back to the legacy
   * flat key shape. Callers should NOT bake `stores/<id>/...` into the
   * `folder` value — that would double-prefix.
   */
  const buildUploadUrl = (
    path: 'image' | 'images' | 'video',
    folder: string,
    storeId?: string,
    aspect?: string
  ) => {
    const params = new URLSearchParams({ folder });
    if (storeId) params.set('storeId', storeId);
    // 2026-05-16: pass the caller's aspect-ratio hint to the API so the
    // upload pipeline auto-resizes via sharp to the recommended dims.
    if (aspect) params.set('aspect', aspect);
    return `${getApiUrl()}/api/v1/uploads/${path}?${params.toString()}`;
  };

  /** One file via POST /uploads/<path>; resolves to its public URL or null (error state set). */
  const uploadOne = useCallback(
    async (
      path: 'image' | 'video',
      file: File,
      folder: string,
      storeId?: string,
      aspect?: string
    ): Promise<string | null> => {
      setError(null);
      setUploading(true);
      setProgress(0);

      const formData = new FormData();
      formData.append('file', file);

      try {
        return await runXhr<string>({
          t,
          url: buildUploadUrl(path, folder, storeId, aspect),
          formData,
          onProgress: setProgress,
          parse: data => {
            if (data.success && data.data?.url) return data.data.url as string;
            throw new Error(uploadErrorText(data, t('errors.uploadFailed')));
          },
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : t('errors.uploadFailed'));
        return null;
      } finally {
        setUploading(false);
        setProgress(0);
      }
    },
    [t]
  );

  const uploadSingle = useCallback(
    (file: File, folder: string, storeId?: string, aspect?: string) =>
      uploadOne('image', file, folder, storeId, aspect),
    [uploadOne]
  );

  /** One mp4/webm (<= 6 MB, enforced by the caller AND the API). */
  const uploadVideo = useCallback(
    (file: File, folder: string, storeId?: string) => uploadOne('video', file, folder, storeId),
    [uploadOne]
  );

  const uploadMulti = useCallback(
    async (files: File[], folder: string, storeId?: string): Promise<string[] | null> => {
      setError(null);
      setUploading(true);
      setProgress(0);

      // FU46-6: the API takes at most IMAGE_UPLOAD_BATCH_MAX files per request, so a larger
      // selection goes in sequential batches; URLs come back in selection order, or null if
      // any batch fails (earlier batches stay in R2 for the orphan sweep).
      const batches = chunk(files, IMAGE_UPLOAD_BATCH_MAX);
      const urls: string[] = [];
      try {
        for (let i = 0; i < batches.length; i++) {
          const formData = new FormData();
          batches[i].forEach(f => formData.append('files', f));
          const batchUrls = await runXhr<string[]>({
            t,
            url: buildUploadUrl('images', folder, storeId),
            formData,
            onProgress: pct => setProgress(Math.round(((i + pct / 100) / batches.length) * 100)),
            parse: data => {
              if (data.success && data.data?.files) {
                return (data.data.files as Array<{ url: string }>).map(f => f.url);
              }
              throw new Error(uploadErrorText(data, t('errors.uploadFailed')));
            },
          });
          urls.push(...batchUrls);
        }
        return urls;
      } catch (err) {
        setError(err instanceof Error ? err.message : t('errors.uploadFailed'));
        return null;
      } finally {
        setUploading(false);
        setProgress(0);
      }
    },
    [t]
  );

  return {
    uploading,
    progress,
    error,
    setError,
    uploadSingle,
    uploadVideo,
    uploadMulti,
  };
}

interface UploadResponse {
  success?: boolean;
  data?: {
    url?: string;
    files?: Array<{ url: string }>;
  };
  error?: { code?: string; message?: string; details?: Record<string, unknown> };
}

interface RunXhrOptions<T> {
  t: Translator;
  url: string;
  formData: FormData;
  onProgress: (pct: number) => void;
  parse: (data: UploadResponse) => T;
}

function runXhr<T>({ t, url, formData, onProgress, parse }: RunXhrOptions<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    xhr.upload.addEventListener('progress', e => {
      if (e.lengthComputable) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    });

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const data: UploadResponse = JSON.parse(xhr.responseText);
          resolve(parse(data));
        } catch (err) {
          if (err instanceof Error && err.message) reject(err);
          else reject(new Error(t('errors.invalidResponse')));
        }
      } else {
        try {
          const data: UploadResponse = JSON.parse(xhr.responseText);
          reject(
            new Error(uploadErrorText(data, t('errors.uploadFailedWithCode', { code: xhr.status })))
          );
        } catch {
          reject(new Error(t('errors.uploadFailedWithCode', { code: xhr.status })));
        }
      }
    });

    xhr.addEventListener('error', () => reject(new Error(t('errors.networkError'))));
    xhr.addEventListener('abort', () => reject(new Error(t('errors.cancelled'))));
    // A stalled upload on a flaky mobile connection can hang forever without
    // firing `error` — cap it so the UI surfaces a real failure instead of a
    // permanent "Uploading…%" spinner.
    xhr.timeout = 60_000;
    xhr.addEventListener('timeout', () => reject(new Error(t('errors.networkError'))));

    xhr.open('POST', url);
    xhr.withCredentials = true;
    xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
    xhr.send(formData);
  });
}
