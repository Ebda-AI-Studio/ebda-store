'use client';

import { useCallback, useEffect, useState } from 'react';
import { Input, Modal, useToast } from '@ebda/ui';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/useT';
import { apiDelete, apiFetch, apiGet, apiPost } from '@/lib/api';

/**
 * Owner self-service store lifecycle (gap A11): export every table, delete the store (typed slug + single-use token +
 * 14-day cooling-off) or cancel a scheduled deletion. Renders nothing for anyone who is not the store owner (the API answers
 * 403 OWNER_ONLY to the status read, and enforces the same on every action; this is only the UI mirror).
 * The super-admin delete (stores list / dashboard danger zone) is a separate, immediate path.
 */
interface DeletionRequest {
  id: string;
  state: 'pending' | 'cancelled' | 'executed';
  executeAfter: string;
  lastBlock?: { code: string };
}
interface Preview {
  slug: string;
  storeName: string;
  coolingOffDays: number;
  confirmToken: string;
}
interface Reason {
  code: string;
  message: string;
}

export function slugMatches(typed: string, slug: string): boolean {
  return typed.length > 0 && typed === slug;
}

const REASON_KEYS: Record<string, string> = {
  STORE_HAS_MONEY_IN_FLIGHT: 'reasonMoney',
  STORE_HAS_BILLED_SUBSCRIPTION: 'reasonBilling',
  STORE_IS_BILLING_PARENT: 'reasonParent',
};

export function OwnerStoreLifecycle({ storeId }: { storeId: string }) {
  const t = useT('storeLifecycle');
  const { success: toastSuccess } = useToast();
  const [isOwner, setIsOwner] = useState(false);
  const [request, setRequest] = useState<DeletionRequest | null>(null);
  const [open, setOpen] = useState(false);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [reasons, setReasons] = useState<Reason[]>([]);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exportMsg, setExportMsg] = useState<string | null>(null);

  const base = `/api/v1/stores/${storeId}`;

  const loadStatus = useCallback(async () => {
    const { data, error: err } = await apiGet<{ request: DeletionRequest | null }>(
      `${base}/deletion`
    );
    if (err || !data) {
      setIsOwner(false);
      return;
    }
    setIsOwner(true);
    setRequest(data.request?.state === 'pending' ? data.request : null);
  }, [base]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const openDialog = useCallback(async () => {
    setOpen(true);
    setTyped('');
    setError(null);
    setPreview(null);
    setReasons([]);
    setLoadingPreview(true);
    const { data, error: err } = await apiPost<Preview>(`${base}/deletion/preview`);
    setLoadingPreview(false);
    if (err) {
      const list = (err.details as { reasons?: Reason[] } | undefined)?.reasons;
      if (err.status === 409 && list?.length) setReasons(list);
      else setError(err.message);
      return;
    }
    setPreview(data);
  }, [base]);

  const submit = useCallback(async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    const { data, error: err } = await apiPost<{ executeAfter: string }>(`${base}/deletion`, {
      confirmToken: preview.confirmToken,
      typedSlug: typed,
    });
    setBusy(false);
    if (err) {
      if (err.code === 'CONFIRM_TOKEN_INVALID') {
        // the single-use token expired or was spent: take a fresh preview, keep the dialog open
        setError(t('errTokenExpired'));
        void openDialog();
        return;
      }
      setError(err.message);
      return;
    }
    toastSuccess(
      t('scheduledToast'),
      t('scheduledToastBody', { date: (data?.executeAfter ?? '').slice(0, 10) })
    );
    setOpen(false);
    await loadStatus();
  }, [preview, base, typed, t, toastSuccess, openDialog, loadStatus]);

  const cancel = useCallback(async () => {
    setBusy(true);
    const { error: err } = await apiDelete(`${base}/deletion`);
    setBusy(false);
    if (err) {
      setError(err.message);
      return;
    }
    toastSuccess(t('cancelledToast'), t('cancelledToastBody'));
    await loadStatus();
  }, [base, t, toastSuccess, loadStatus]);

  const download = useCallback(async () => {
    setExportMsg(null);
    setBusy(true);
    try {
      const res = await apiFetch(`${base}/export`);
      if (res.status === 413) return setExportMsg(t('errExportTooLarge'));
      if (res.status === 429) return setExportMsg(t('errExportRateLimited'));
      if (!res.ok) return setExportMsg(t('errExportFailed'));
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download =
        /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ??
        'store-export.zip';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      setExportMsg(t('errExportFailed'));
    } finally {
      setBusy(false);
    }
  }, [base, t]);

  if (!isOwner) return null;

  return (
    <section className="mt-10 space-y-6" aria-labelledby="owner-lifecycle-title">
      <h2 id="owner-lifecycle-title" className="font-semibold text-foreground">
        {t('title')}
      </h2>
      <div className="rounded-xl border border-border p-6">
        <p className="text-sm font-medium text-foreground">{t('exportTitle')}</p>
        <p className="mt-1 text-sm text-muted-foreground">{t('exportBody')}</p>
        <div className="mt-4">
          <Button variant="outline" onClick={download} disabled={busy} isLoading={busy}>
            {t('exportButton')}
          </Button>
        </div>
        {exportMsg && (
          <p role="alert" className="mt-3 text-sm text-destructive-ink">
            {exportMsg}
          </p>
        )}
      </div>
      <div className="rounded-xl border-2 border-destructive/40 bg-destructive/5 p-6">
        <p className="text-sm font-medium text-foreground">{t('deleteTitle')}</p>
        {request ? (
          <>
            <p className="mt-1 text-sm text-foreground">
              {t('pendingBody', { date: request.executeAfter.slice(0, 10) })}
            </p>
            {request.lastBlock && (
              <p role="status" className="mt-2 text-sm text-destructive-ink">
                {t(REASON_KEYS[request.lastBlock.code] ?? 'reasonMoney')}
              </p>
            )}
            <div className="mt-4">
              <Button variant="outline" onClick={cancel} disabled={busy} isLoading={busy}>
                {t('cancelButton')}
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="mt-1 text-sm text-muted-foreground">{t('deleteBody')}</p>
            <div className="mt-4">
              <Button variant="destructive" onClick={openDialog}>
                {t('deleteButton')}
              </Button>
            </div>
          </>
        )}
        {error && !open && (
          <p role="alert" className="mt-3 text-sm text-destructive-ink">
            {error}
          </p>
        )}
      </div>

      <Modal
        isOpen={open}
        onClose={busy ? () => {} : () => setOpen(false)}
        title={t('dialogTitle')}
      >
        {loadingPreview && <p className="text-sm text-muted-foreground">{t('checking')}</p>}
        {reasons.length > 0 && (
          <div className="space-y-3">
            <p className="text-sm font-medium text-foreground">{t('refusedTitle')}</p>
            <ul className="list-disc space-y-1 ps-5 text-sm text-destructive-ink">
              {reasons.map(r => (
                <li key={r.code}>{t(REASON_KEYS[r.code] ?? 'reasonMoney')}</li>
              ))}
            </ul>
          </div>
        )}
        {preview && (
          <div className="space-y-4">
            <p className="text-sm text-foreground">
              {t('consequence', { name: preview.storeName, days: String(preview.coolingOffDays) })}
            </p>
            <div>
              <label
                htmlFor="owner-delete-slug"
                className="mb-2 block text-sm font-medium text-foreground"
              >
                {t('typeSlugLabel', { slug: preview.slug })}
              </label>
              <Input
                id="owner-delete-slug"
                value={typed}
                onChange={e => setTyped(e.target.value)}
                disabled={busy}
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                dir="ltr"
              />
            </div>
            <Button
              variant="destructive"
              disabled={busy || !slugMatches(typed, preview.slug)}
              isLoading={busy}
              onClick={submit}
            >
              {t('submit')}
            </Button>
          </div>
        )}
        {error && (
          <p role="alert" className="mt-3 text-sm text-destructive-ink">
            {error}
          </p>
        )}
      </Modal>
    </section>
  );
}
