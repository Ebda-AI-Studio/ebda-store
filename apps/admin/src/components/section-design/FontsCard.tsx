'use client';

/**
 * The font library card: add a Google font (family, URL built for you) or upload a custom font file
 * (.woff2/.woff/.ttf/.otf, stored in the store's R2 area through `/uploads/font`). Shared by the
 * form page builder and the visual editor's theme pane; the CALLER decides where the list is kept
 * (the editor keeps it in the draft document, Ruling VE-4).
 */
import { Button } from '@/components/ui/Button';
import { useState } from 'react';
import { useT } from '@/i18n/useT';
import { apiFetch, localizedApiMessage } from '../../lib/api';
import { FIELD_CLASSES } from '@/components/ui/tokens';

// ---------------------------------------------------------------------------
// Font library — Ahmad 2026-05-20.
// ---------------------------------------------------------------------------
// Merchant manages the typography.fonts array consumed by the storefront
// (apps/web/src/app/layout.tsx → renders <link rel="stylesheet"> per Google
// entry, and @font-face per custom entry).
//
// v1 ships ADD GOOGLE FONT (family + URL → push to array) + REMOVE per entry.
// Custom font upload (v2.5) needs an R2 upload endpoint + format detection;
// merchants who need a custom font today can hand-edit the JSONB via
// /api/v1/stores/:id/typography.
export type FontEntry = {
  type: 'google' | 'custom';
  family: string;
  url: string;
  format?: string;
};

export function FontsCard({
  storeId,
  fonts,
  onChange,
}: {
  storeId: string;
  fonts: FontEntry[];
  onChange: (next: FontEntry[]) => void;
}) {
  const t = useT('orders.layout');
  const [showAdd, setShowAdd] = useState(false);
  const [family, setFamily] = useState('');
  const [url, setUrl] = useState('');
  // Custom upload state
  const [showUpload, setShowUpload] = useState(false);
  const [uploadFamily, setUploadFamily] = useState('');
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  function addGoogle() {
    const trimmedFamily = family.trim();
    const trimmedUrl = url.trim();
    if (!trimmedFamily) return;
    // If URL missing, auto-build the standard Google Fonts URL from the family.
    // Quote-wrap families with spaces ("Open Sans" → "Open+Sans").
    const finalUrl = trimmedUrl
      ? trimmedUrl
      : `https://fonts.googleapis.com/css2?family=${encodeURIComponent(
          trimmedFamily.replace(/\s+/g, '+')
        )}:wght@300;400;500;600;700&display=swap`;
    onChange([...fonts, { type: 'google', family: trimmedFamily, url: finalUrl }]);
    setFamily('');
    setUrl('');
    setShowAdd(false);
  }

  function remove(idx: number) {
    onChange(fonts.filter((_, i) => i !== idx));
  }

  async function uploadCustom() {
    setUploadError(null);
    const fam = uploadFamily.trim();
    if (!fam || !uploadFile) {
      setUploadError('Family name and font file are both required.');
      return;
    }
    setIsUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', uploadFile);
      const res = await apiFetch(`/api/v1/uploads/font?storeId=${encodeURIComponent(storeId)}`, {
        method: 'POST',
        body: formData,
      });
      const data = (await res.json()) as {
        success?: boolean;
        data?: { url?: string; format?: string };
        error?: { code?: string; message?: string; details?: Record<string, unknown> };
      };
      if (!res.ok || !data.success || !data.data?.url) {
        setUploadError(
          localizedApiMessage(
            data.error?.code,
            data.error?.message ?? `Upload failed (HTTP ${res.status})`,
            data.error?.details,
            res.status
          )
        );
        return;
      }
      onChange([
        ...fonts,
        {
          type: 'custom',
          family: fam,
          url: data.data.url,
          format: data.data.format ?? 'woff2',
        },
      ]);
      setUploadFamily('');
      setUploadFile(null);
      setShowUpload(false);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : t('fonts.uploadFailed'));
    } finally {
      setIsUploading(false);
    }
  }

  return (
    <section className="rounded-2xl border border-border bg-card p-4 sm:p-5">
      <div className="mb-3">
        <h3 className="text-base font-semibold text-foreground">{t('fonts.title')}</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">{t('fonts.description')}</p>
      </div>
      {fonts.length > 0 && (
        <ul className="mb-3 space-y-1.5">
          {fonts.map((f, i) => (
            <li
              key={`${f.family}-${i}`}
              className="flex items-center gap-3 rounded-lg border border-border bg-background px-3 py-2"
            >
              <span
                className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-semibold uppercase tracking-wide ${
                  f.type === 'google'
                    ? 'bg-sky-100 text-sky-800'
                    : 'bg-emerald-100 text-emerald-800'
                }`}
              >
                {f.type === 'google' ? t('fonts.google') : t('fonts.custom')}
              </span>
              <span
                className="flex-1 truncate text-sm font-medium text-foreground"
                style={{ fontFamily: `"${f.family}", system-ui` }}
              >
                {f.family}
              </span>
              <Button
                variant="outline"
                size="sm"
                type="button"
                onClick={() => remove(i)}
                className="font-semibold text-destructive-ink"
              >
                {t('fonts.remove')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {showAdd ? (
        <div className="space-y-2 rounded-lg border border-dashed border-border bg-muted/20 p-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">
              {t('fonts.familyNameLabel')}
            </span>
            <input
              type="text"
              value={family}
              onChange={e => setFamily(e.target.value)}
              placeholder={t('fontFamilyExample')}
              className={FIELD_CLASSES}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">
              {t('fonts.googleUrlLabel')}
            </span>
            <input
              type="text"
              value={url}
              onChange={e => setUrl(e.target.value)}
              placeholder="https://fonts.googleapis.com/css2?family=..."
              className={FIELD_CLASSES}
            />
          </label>
          <div className="flex justify-end gap-2 pt-1">
            <Button
              variant="outline"
              size="sm"
              type="button"
              onClick={() => {
                setShowAdd(false);
                setFamily('');
                setUrl('');
              }}
              className="font-semibold"
            >
              {t('common.cancel')}
            </Button>
            <Button
              size="sm"
              type="button"
              disabled={!family.trim()}
              onClick={addGoogle}
              className="font-semibold"
            >
              {t('fonts.addFont')}
            </Button>
          </div>
        </div>
      ) : showUpload ? (
        <div className="space-y-2 rounded-lg border border-dashed border-border bg-muted/20 p-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">
              {t('fonts.familyNameDisplayLabel')}
            </span>
            <input
              type="text"
              value={uploadFamily}
              onChange={e => setUploadFamily(e.target.value)}
              placeholder={t('fontNameExample')}
              className={FIELD_CLASSES}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">
              {t('fonts.fileLabel')}
            </span>
            <input
              type="file"
              accept=".woff2,.woff,.ttf,.otf,font/woff2,font/woff,font/ttf,font/otf"
              onChange={e => setUploadFile(e.target.files?.[0] ?? null)}
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
            />
            {uploadFile && (
              <span className="text-xs text-muted-foreground">
                {t('uploadFileSize', {
                  name: uploadFile.name,
                  kb: Math.round(uploadFile.size / 1024),
                })}
              </span>
            )}
          </label>
          {uploadError && (
            <p className="rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive-ink">
              {uploadError}
            </p>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <Button
              variant="outline"
              size="sm"
              type="button"
              disabled={isUploading}
              onClick={() => {
                setShowUpload(false);
                setUploadFamily('');
                setUploadFile(null);
                setUploadError(null);
              }}
              className="font-semibold"
            >
              {t('common.cancel')}
            </Button>
            <Button
              size="sm"
              type="button"
              disabled={!uploadFamily.trim() || !uploadFile || isUploading}
              onClick={uploadCustom}
              className="font-semibold"
            >
              {isUploading ? t('fonts.uploading') : t('fonts.uploadFont')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Button
            variant="outline"
            type="button"
            onClick={() => setShowAdd(true)}
            className="font-semibold text-muted-foreground"
          >
            {t('fonts.addGoogleFont')}
          </Button>
          <Button
            variant="outline"
            type="button"
            onClick={() => setShowUpload(true)}
            className="font-semibold text-muted-foreground"
          >
            {t('fonts.uploadCustomFont')}
          </Button>
        </div>
      )}
    </section>
  );
}
