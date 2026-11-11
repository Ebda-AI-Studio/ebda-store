'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale } from 'next-intl';
import {
  TAX_DOCUMENT_KINDS,
  TAX_DOCUMENT_MAX_BYTES,
  TAX_DOCUMENT_MAX_COUNT,
  TAX_DOCUMENT_MIME_TYPES,
  TAX_PROFILE_EDITABLE_STATUSES,
  normalizeTaxRegistrationNumber,
  type TaxDocumentKindValue,
  type TaxProfileStatusValue,
  withNumerals,
} from '@ebda/shared';
import { useT } from '@/i18n/useT';
import { apiDelete, apiFetch, apiGet, apiPost, apiPut, localizedApiMessage } from '@/lib/api';
import { openProtectedDocument } from '@/lib/open-document';
import { useConfirm } from '@/hooks/useConfirm';

import { Button } from '@/components/ui/Button';
export interface TaxDocument {
  id: string;
  kind: TaxDocumentKindValue;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
}

export interface TaxProfile {
  status: TaxProfileStatusValue;
  taxRegistrationNumber: string | null;
  legalName: string | null;
  attestedAt: string | null;
  submittedAt: string | null;
  reviewedAt: string | null;
  verifiedAt: string | null;
  revokedAt: string | null;
  rejectionReason: string | null;
  documents: TaxDocument[];
}

interface Props {
  storeId: string;
  /** Reports the current status (and re-reports after every change). */
  onStatusChange?: (status: TaxProfileStatusValue) => void;
}

const BANNER_TONE: Record<TaxProfileStatusValue, string> = {
  none: 'border-border bg-muted/40 text-foreground',
  pending: 'border-warning/30 bg-warning/10 text-warning-ink',
  verified: 'border-success/30 bg-success/10 text-success-ink',
  rejected: 'border-destructive/30 bg-destructive/10 text-destructive-ink',
  revoked: 'border-destructive/30 bg-destructive/10 text-destructive-ink',
};

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * VAT registration gate (ruling TAX-2): a store may charge VAT only once a
 * super-admin has verified its registration. This card collects the TRN, legal
 * name and evidence, and submits it for manual review.
 */
export function TaxVerificationCard({ storeId, onStatusChange }: Props) {
  const t = useT('taxVerification');
  const askConfirm = useConfirm();
  const locale = useLocale();
  const base = `/api/v1/stores/${storeId}/tax/profile`;

  const [profile, setProfile] = useState<TaxProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [trn, setTrn] = useState('');
  const [legalName, setLegalName] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState<null | 'save' | 'upload' | 'submit'>(null);
  const [kind, setKind] = useState<TaxDocumentKindValue>('tax_card');
  const [file, setFile] = useState<File | null>(null);
  const [attest, setAttest] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const onStatusRef = useRef(onStatusChange);
  onStatusRef.current = onStatusChange;

  const apply = useCallback((p: TaxProfile) => {
    setProfile(p);
    setTrn(p.taxRegistrationNumber ?? '');
    setLegalName(p.legalName ?? '');
    onStatusRef.current?.(p.status);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await apiGet<{ profile: TaxProfile }>(base);
      if (cancelled) return;
      if (error || !data?.profile) setLoadError(true);
      else apply(data.profile);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [base, apply]);

  const errorText = (code?: string, fallback?: string) => {
    if (code === 'TOO_MANY_DOCUMENTS') return t('documents.tooMany');
    if (code === 'INVALID_FILE_TYPE') return t('documents.invalidType');
    if (code === 'TAX_PROFILE_INCOMPLETE') return t('submit.incomplete');
    return fallback || t('error');
  };

  if (loading) {
    return (
      <div id="vat-registration" className="rounded-md border border-border bg-card p-4 mb-4">
        <p className="text-sm text-muted-foreground">{t('loading')}</p>
      </div>
    );
  }
  if (loadError || !profile) {
    return (
      <div id="vat-registration" className="rounded-md border border-border bg-card p-4 mb-4">
        <p role="alert" className="text-sm text-destructive-ink">
          {t('loadFailed')}
        </p>
      </div>
    );
  }

  const editable = TAX_PROFILE_EDITABLE_STATUSES.includes(profile.status);
  const status = profile.status;
  const dateFmt = (iso: string | null) =>
    iso
      ? new Date(iso).toLocaleDateString(locale === 'ar' ? 'ar-EG' : 'en-GB', withNumerals())
      : '';

  const banner = t(`banner.${status}`, {
    date: dateFmt(profile.verifiedAt),
    reason: profile.rejectionReason ?? '',
  });

  const saveDetails = async () => {
    setMessage(null);
    const normalized = normalizeTaxRegistrationNumber(trn);
    if (!/^\d{9}$/.test(normalized)) return setFieldError(t('form.trnInvalid'));
    const name = legalName.trim();
    if (name.length < 2 || name.length > 200) return setFieldError(t('form.legalNameInvalid'));
    setFieldError(null);
    setBusy('save');
    const { data, error } = await apiPut<{ profile: TaxProfile }>(base, {
      taxRegistrationNumber: trn,
      legalName: name,
    });
    setBusy(null);
    if (error || !data?.profile)
      setMessage({ tone: 'error', text: errorText(error?.code, error?.message) });
    else {
      apply(data.profile);
      setMessage({ tone: 'ok', text: t('form.saved') });
    }
  };

  const chooseFile = (f: File | null) => {
    setMessage(null);
    if (f) {
      if (!(TAX_DOCUMENT_MIME_TYPES as readonly string[]).includes(f.type)) {
        setFile(null);
        if (fileInput.current) fileInput.current.value = '';
        return setMessage({ tone: 'error', text: t('documents.invalidType') });
      }
      if (f.size > TAX_DOCUMENT_MAX_BYTES) {
        setFile(null);
        if (fileInput.current) fileInput.current.value = '';
        return setMessage({ tone: 'error', text: t('documents.tooLarge') });
      }
    }
    setFile(f);
  };

  const reload = async () => {
    const { data } = await apiGet<{ profile: TaxProfile }>(base);
    if (data?.profile) apply(data.profile);
  };

  const upload = async () => {
    setMessage(null);
    if (!file) return setMessage({ tone: 'error', text: t('documents.noFile') });
    if (profile.documents.length >= TAX_DOCUMENT_MAX_COUNT)
      return setMessage({ tone: 'error', text: t('documents.tooMany') });
    setBusy('upload');
    const form = new FormData();
    form.append('kind', kind);
    form.append('file', file);
    let failure: string | null = null;
    try {
      const res = await apiFetch(`${base}/documents`, { method: 'POST', body: form });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { code?: string; message?: string; details?: Record<string, unknown> };
        } | null;
        // A raw fetch: the API's English text goes through the same map as apiRequest (Ruling ADMIN-ERR-1).
        failure = errorText(
          body?.error?.code,
          localizedApiMessage(
            body?.error?.code,
            body?.error?.message || t('error'),
            body?.error?.details,
            res.status
          )
        );
      }
    } catch {
      failure = t('error');
    }
    setBusy(null);
    if (failure) return setMessage({ tone: 'error', text: failure });
    setFile(null);
    if (fileInput.current) fileInput.current.value = '';
    await reload();
    setMessage({ tone: 'ok', text: t('documents.uploaded') });
  };

  const removeDoc = async (doc: TaxDocument) => {
    const ok = await askConfirm({
      object: t('documents.deleteObject', { name: doc.fileName ?? '' }),
      consequence: t('documents.deleteConsequence'),
      confirmLabel: t('documents.deleteLabel'),
      tone: 'danger',
    });
    if (!ok) return;
    setMessage(null);
    const { error } = await apiDelete(`${base}/documents/${doc.id}`);
    if (error) return setMessage({ tone: 'error', text: errorText(error.code, error.message) });
    await reload();
  };

  const view = async (doc: TaxDocument) => {
    setMessage(null);
    const ok = await openProtectedDocument(`${base}/documents/${doc.id}/file`);
    if (!ok) setMessage({ tone: 'error', text: t('documents.openFailed') });
  };

  const submit = async () => {
    setMessage(null);
    setBusy('submit');
    const { data, error } = await apiPost<{ profile: TaxProfile }>(`${base}/submit`, {
      attest: true,
    });
    setBusy(null);
    if (error || !data?.profile)
      return setMessage({ tone: 'error', text: errorText(error?.code, error?.message) });
    setAttest(false);
    apply(data.profile);
    setMessage({ tone: 'ok', text: t('submit.submitted') });
  };

  const inputCls =
    'w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground disabled:opacity-60';

  return (
    <section
      id="vat-registration"
      aria-labelledby="vat-registration-title"
      className="rounded-md border border-border bg-card p-4 mb-4 space-y-4"
    >
      <div>
        <h2 id="vat-registration-title" className="text-base font-semibold text-foreground">
          {t('title')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>

      <div
        data-testid="vat-status-banner"
        data-status={status}
        className={`rounded-md border px-3 py-2 text-sm ${BANNER_TONE[status]}`}
      >
        <p className="font-medium">{t(`status.${status}`)}</p>
        <p>{banner}</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-foreground">{t('form.trn')}</span>
          <input
            dir="ltr"
            inputMode="numeric"
            className={`${inputCls} text-start`}
            value={trn}
            placeholder={t('form.trnPlaceholder')}
            disabled={!editable || busy !== null}
            onChange={e => setTrn(e.target.value)}
          />
          <span className="mt-1 block text-xs text-muted-foreground">{t('form.trnHint')}</span>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-foreground">{t('form.legalName')}</span>
          <input
            className={inputCls}
            value={legalName}
            disabled={!editable || busy !== null}
            onChange={e => setLegalName(e.target.value)}
          />
          <span className="mt-1 block text-xs text-muted-foreground">
            {t('form.legalNameHint')}
          </span>
        </label>
      </div>
      {fieldError && (
        <p role="alert" className="text-sm text-destructive-ink">
          {fieldError}
        </p>
      )}
      {editable ? (
        <Button
          type="button"
          onClick={saveDetails}
          disabled={busy !== null}
          variant="outline"
          size="sm"
        >
          {busy === 'save' ? t('form.saving') : t('form.save')}
        </Button>
      ) : (
        <p className="text-xs text-muted-foreground">
          {status === 'verified' ? t('verifiedNote') : t('form.locked')}
        </p>
      )}

      <div className="space-y-2">
        <div>
          <h3 className="text-sm font-medium text-foreground">{t('documents.title')}</h3>
          <p className="text-xs text-muted-foreground">{t('documents.hint')}</p>
        </div>
        {profile.documents.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('documents.empty')}</p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {profile.documents.map(doc => (
              <li
                key={doc.id}
                className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"
              >
                <span className="min-w-0">
                  <span className="font-medium text-foreground">
                    {t(`documents.kind.${doc.kind}`)}
                  </span>
                  <span className="mx-2 break-all text-muted-foreground" dir="auto">
                    {doc.fileName}
                  </span>
                  <span className="text-xs text-muted-foreground">{formatSize(doc.sizeBytes)}</span>
                </span>
                <span className="flex gap-3">
                  <button
                    type="button"
                    onClick={() => view(doc)}
                    className="text-primary hover:underline"
                  >
                    {t('documents.view')}
                  </button>
                  {editable && (
                    <button
                      type="button"
                      onClick={() => removeDoc(doc)}
                      className="text-destructive-ink hover:underline"
                    >
                      {t('documents.delete')}
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}

        {editable && (
          <div className="flex flex-wrap items-end gap-2">
            <label className="block text-sm">
              <span className="mb-1 block text-xs font-medium text-foreground">
                {t('documents.kindLabel')}
              </span>
              <select
                className={inputCls}
                value={kind}
                onChange={e => setKind(e.target.value as TaxDocumentKindValue)}
                disabled={busy !== null}
              >
                {TAX_DOCUMENT_KINDS.map(k => (
                  <option key={k} value={k}>
                    {t(`documents.kind.${k}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-xs font-medium text-foreground">
                {t('documents.fileLabel')}
              </span>
              <input
                ref={fileInput}
                type="file"
                accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
                className="text-sm"
                disabled={busy !== null}
                onChange={e => chooseFile(e.target.files?.[0] ?? null)}
              />
            </label>
            <Button
              type="button"
              onClick={upload}
              disabled={busy !== null}
              variant="outline"
              size="sm"
            >
              {busy === 'upload' ? t('documents.uploading') : t('documents.upload')}
            </Button>
          </div>
        )}
      </div>

      {editable && (
        <div className="space-y-2 border-t border-border pt-3">
          <label className="flex items-start gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={attest}
              onChange={e => setAttest(e.target.checked)}
              disabled={busy !== null}
            />
            <span>{t('submit.attest')}</span>
          </label>
          <Button
            type="button"
            onClick={submit}
            disabled={!attest || busy !== null}
            variant="default"
            size="sm"
          >
            {busy === 'submit' ? t('submit.submitting') : t('submit.button')}
          </Button>
          <p className="text-xs text-muted-foreground">{t('submit.disclaimer')}</p>
        </div>
      )}

      {message && (
        <p
          role={message.tone === 'error' ? 'alert' : 'status'}
          className={`text-sm ${message.tone === 'error' ? 'text-destructive-ink' : 'text-success-ink'}`}
        >
          {message.text}
        </p>
      )}
    </section>
  );
}
