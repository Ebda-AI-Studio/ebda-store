'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import { useT } from '@/i18n/useT';
import { getApiUrl, localizedApiMessage } from '../../../../../lib/api';
import { UploadDropzone } from '../../../../../components/image-upload/UploadDropzone';
import { UploadProgress } from '../../../../../components/image-upload/UploadProgress';
import type { PWASettings } from './types';
import { FIELD_CLASSES } from '@/components/ui/tokens';

interface PwaIconUploaderProps {
  storeId: string;
  settings: PWASettings;
  pwaEnabled: boolean;
  onChange: (settings: PWASettings) => void;
}

// The API stores the source as sent under every icon size (Ruling FU46-8, no image library on
// Workers), so it takes a square PNG of 512×512+ and at most 1 MB (pwa.routes.ts).
const MAX_ICON_SIZE = 1024 * 1024;
const ACCEPTED_TYPES = ['image/png'];

interface IconUploadResponse {
  success?: boolean;
  data?: { settings?: PWASettings };
  error?: { code?: string; message?: string; details?: Record<string, unknown> };
}

/**
 * Merge ONLY the icon fields a completed upload generated into `current`
 * local settings, rather than replacing the whole object with the server's
 * response (#1915). `uploaded` is what `PWAService.updateSettings` persisted
 * server-side — the DB row as it existed AT UPLOAD TIME plus the new icon
 * URLs. If the merchant has unsaved edits in a sibling section (app name,
 * theme color, iOS settings…) those never reached the server, so replacing
 * local state with the server's copy would silently discard them the moment
 * an icon upload finished.
 */
export function mergeIconFields(current: PWASettings, uploaded: PWASettings): PWASettings {
  return {
    ...current,
    iconSource: uploaded.iconSource,
    icon192: uploaded.icon192,
    icon384: uploaded.icon384,
    icon512: uploaded.icon512,
    iconAppleTouch: uploaded.iconAppleTouch,
    favicon32: uploaded.favicon32,
    favicon16: uploaded.favicon16,
    maskableIcon: uploaded.maskableIcon,
  };
}

/**
 * Single drag-drop uploader for the store's PWA icon (B5, 2026-05-04 plan
 * task 6): the merchant uploads ONE square 512x512+ source image and the API
 * (`POST /stores/:id/pwa/icons`) generates the full size set server-side —
 * 192/384/512/maskable + apple-touch (180) + favicons (32/16). Replaces the
 * pre-B5 three-URL-field form; those raw URL inputs are kept below as an
 * "Advanced" disclosure for merchants who want to hand-override one size
 * without re-uploading a source.
 */
export function PwaIconUploader({ storeId, settings, pwaEnabled, onChange }: PwaIconUploaderProps) {
  const t = useT('pwa.icons');
  const tUpload = useT('components.imageUpload');
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // The merge base must be the settings as they are when the upload
  // RESOLVES, not when the drop handler was created: the upload can run for
  // up to 60s, and the merchant may keep editing sibling fields meanwhile.
  // Merging against the closure's copy reverted those in-flight edits.
  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  const handleFiles = useCallback(
    async (fileList: FileList) => {
      const file = fileList[0];
      if (!file) return;

      if (!ACCEPTED_TYPES.includes(file.type)) {
        setError(tUpload('errors.typeNotAccepted', { type: file.type }));
        return;
      }
      if (file.size > MAX_ICON_SIZE) {
        setError(t('tooLarge'));
        return;
      }

      setError(null);
      setUploading(true);
      setProgress(0);

      const formData = new FormData();
      formData.append('source', file);

      try {
        const updatedSettings = await new Promise<PWASettings>((resolve, reject) => {
          const xhr = new XMLHttpRequest();

          xhr.upload.addEventListener('progress', e => {
            if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100));
          });

          xhr.addEventListener('load', () => {
            let data: IconUploadResponse | null = null;
            try {
              data = JSON.parse(xhr.responseText);
            } catch {
              reject(new Error(tUpload('errors.invalidResponse')));
              return;
            }
            if (xhr.status >= 200 && xhr.status < 300 && data?.success && data.data?.settings) {
              resolve(data.data.settings);
            } else {
              reject(
                new Error(
                  localizedApiMessage(
                    data?.error?.code,
                    data?.error?.message ||
                      tUpload('errors.uploadFailedWithCode', { code: xhr.status }),
                    data?.error?.details,
                    xhr.status
                  )
                )
              );
            }
          });

          xhr.addEventListener('error', () => reject(new Error(tUpload('errors.networkError'))));
          xhr.addEventListener('abort', () => reject(new Error(tUpload('errors.cancelled'))));
          // Same floor as useImageUpload's runXhr — a stalled mobile upload
          // must surface a real failure instead of spinning forever.
          xhr.timeout = 60_000;
          xhr.addEventListener('timeout', () => reject(new Error(tUpload('errors.networkError'))));

          xhr.open('POST', `${getApiUrl()}/api/v1/stores/${storeId}/pwa/icons`);
          xhr.withCredentials = true;
          xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
          xhr.send(formData);
        });

        onChange(mergeIconFields(settingsRef.current, updatedSettings));
      } catch (err) {
        setError(err instanceof Error ? err.message : tUpload('errors.uploadFailed'));
      } finally {
        setUploading(false);
        setProgress(0);
      }
    },
    [onChange, storeId, t, tUpload]
  );

  return (
    <div className="bg-card rounded-xl border border-border p-6">
      <h2 className="text-lg font-semibold text-foreground mb-1">{t('title')}</h2>
      <p className="text-sm text-muted-foreground mb-4">{t('uploaderHelp')}</p>

      <div className={pwaEnabled ? '' : 'opacity-50 pointer-events-none'}>
        <div className="max-w-xs">
          <UploadDropzone
            accept={ACCEPTED_TYPES.join(',')}
            onFiles={handleFiles}
            paddingClass="p-6"
          >
            {uploading ? (
              <UploadProgress
                progress={progress}
                label={tUpload('uploadingPercent', { progress })}
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
                <p className="mt-1 text-sm text-muted-foreground">{t('uploaderLabel')}</p>
                <p className="text-xs text-muted-foreground">{tUpload('browse')}</p>
              </>
            )}
          </UploadDropzone>
        </div>
        <p className="text-xs text-muted-foreground mt-2">{t('uploaderSizeHint')}</p>
        {error && <p className="mt-1 text-xs text-destructive-ink">{error}</p>}

        {(settings.icon192 || settings.iconAppleTouch || settings.favicon32) && (
          <div className="mt-4">
            <p className="text-xs font-medium text-muted-foreground mb-2">
              {t('generatedPreview')}
            </p>
            <div className="flex flex-wrap items-end gap-4">
              {settings.icon192 && (
                <div className="text-center">
                  <Image
                    src={settings.icon192}
                    alt={t('icon192Alt')}
                    width={48}
                    height={48}
                    className="w-12 h-12 rounded-lg object-contain bg-muted border mx-auto"
                  />
                  <p className="text-xs text-muted-foreground mt-1">192×192</p>
                </div>
              )}
              {settings.iconAppleTouch && (
                <div className="text-center">
                  <Image
                    src={settings.iconAppleTouch}
                    alt={t('iconAppleTouchAlt')}
                    width={45}
                    height={45}
                    className="w-[45px] h-[45px] rounded-lg object-contain bg-muted border mx-auto"
                  />
                  <p className="text-xs text-muted-foreground mt-1">180×180</p>
                </div>
              )}
              {settings.favicon32 && (
                <div className="text-center">
                  <Image
                    src={settings.favicon32}
                    alt={t('favicon32Alt')}
                    width={32}
                    height={32}
                    className="w-8 h-8 rounded object-contain bg-muted border mx-auto"
                  />
                  <p className="text-xs text-muted-foreground mt-1">32×32</p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <details
        className="mt-6"
        open={advancedOpen}
        onToggle={e => setAdvancedOpen((e.target as HTMLDetailsElement).open)}
      >
        <summary className="text-sm font-medium text-muted-foreground cursor-pointer select-none">
          {t('advancedToggle')}
        </summary>
        <div
          className={`grid grid-cols-1 md:grid-cols-3 gap-6 mt-4 ${pwaEnabled ? '' : 'opacity-50 pointer-events-none'}`}
        >
          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-2">
              {t('icon192')}
            </label>
            <input
              type="text"
              value={settings.icon192 || ''}
              onChange={e => onChange({ ...settings, icon192: e.target.value })}
              placeholder={t('urlPlaceholder')}
              className={FIELD_CLASSES}
              disabled={!pwaEnabled}
            />
            {settings.icon192 && (
              <Image
                src={settings.icon192}
                alt={t('icon192Alt')}
                width={48}
                height={48}
                className="mt-2 w-12 h-12 rounded-lg object-contain bg-muted border"
              />
            )}
            <p className="text-xs text-muted-foreground mt-1">{t('icon192Help')}</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-2">
              {t('icon512')}
            </label>
            <input
              type="text"
              value={settings.icon512 || ''}
              onChange={e => onChange({ ...settings, icon512: e.target.value })}
              placeholder={t('urlPlaceholder')}
              className={FIELD_CLASSES}
              disabled={!pwaEnabled}
            />
            {settings.icon512 && (
              <Image
                src={settings.icon512}
                alt={t('icon512Alt')}
                width={48}
                height={48}
                className="mt-2 w-12 h-12 rounded-lg object-contain bg-muted border"
              />
            )}
            <p className="text-xs text-muted-foreground mt-1">{t('icon512Help')}</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-2">
              {t('maskable')}
            </label>
            <input
              type="text"
              value={settings.maskableIcon || ''}
              onChange={e => onChange({ ...settings, maskableIcon: e.target.value })}
              placeholder={t('urlPlaceholder')}
              className={FIELD_CLASSES}
              disabled={!pwaEnabled}
            />
            {settings.maskableIcon && (
              <Image
                src={settings.maskableIcon}
                alt={t('maskableAlt')}
                width={48}
                height={48}
                className="mt-2 w-12 h-12 rounded-lg object-contain bg-muted border"
              />
            )}
            <p className="text-xs text-muted-foreground mt-1">{t('maskableHelp')}</p>
          </div>
        </div>
      </details>
    </div>
  );
}
