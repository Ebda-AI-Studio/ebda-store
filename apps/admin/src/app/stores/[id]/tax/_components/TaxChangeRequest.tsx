'use client';

import { useEffect, useState } from 'react';
import {
  TAX_DOCUMENT_KINDS,
  TAX_DOCUMENT_MAX_BYTES,
  TAX_DOCUMENT_MIME_TYPES,
  normalizeTaxRegistrationNumber,
  type TaxDocumentKindValue,
} from '@ebda/shared';
import { useT } from '@/i18n/useT';
import { apiDelete, apiFetch, apiGet, localizedApiMessage } from '@/lib/api';
import { useConfirm } from '@/hooks/useConfirm';
import { Button } from '@/components/ui/Button';

interface Pending {
  taxRegistrationNumber: string;
  legalName: string;
  fileName: string;
}
interface State {
  request: Pending | null;
  lastRejection: { reason: string } | null;
}
type Answer = {
  success?: boolean;
  data?: { confirmationRequired?: boolean; confirmToken?: string };
  error?: { code?: string; message?: string; details?: Record<string, unknown> };
};

/**
 * Change of a VERIFIED VAT registration (self-service A10). The verified state stays as it is, and VAT keeps charging, until
 * Ebda AI Studio approves the new details; the merchant sends the new number, name and document, confirms once, and can withdraw.
 */
export function TaxChangeRequest({ storeId }: { storeId: string }) {
  const t = useT('taxVerification');
  const askConfirm = useConfirm();
  const url = `/api/v1/stores/${storeId}/tax/change-request`;
  const [state, setState] = useState<State | null>(null);
  const [open, setOpen] = useState(false);
  const [trn, setTrn] = useState('');
  const [legalName, setLegalName] = useState('');
  const [kind, setKind] = useState<TaxDocumentKindValue>('tax_card');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const load = async () => {
    const { data } = await apiGet<State>(url);
    setState({ request: data?.request ?? null, lastRejection: data?.lastRejection ?? null });
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  const post = async (
    token?: string
  ): Promise<{ answer: Answer | null; failure: string | null }> => {
    const form = new FormData();
    form.append('taxRegistrationNumber', trn);
    form.append('legalName', legalName.trim());
    form.append('kind', kind);
    if (token) form.append('confirmToken', token);
    form.append('file', file as File);
    try {
      const res = await apiFetch(url, { method: 'POST', body: form });
      const body = (await res.json().catch(() => null)) as Answer | null;
      if (!res.ok)
        return {
          answer: null,
          failure: localizedApiMessage(
            body?.error?.code,
            body?.error?.message || t('error'),
            body?.error?.details,
            res.status
          ),
        };
      return { answer: body, failure: null };
    } catch {
      return { answer: null, failure: t('error') };
    }
  };

  const send = async () => {
    setMessage(null);
    if (!/^\d{9}$/.test(normalizeTaxRegistrationNumber(trn)))
      return setMessage({ tone: 'error', text: t('form.trnInvalid') });
    if (legalName.trim().length < 2)
      return setMessage({ tone: 'error', text: t('form.legalNameInvalid') });
    if (!file) return setMessage({ tone: 'error', text: t('documents.noFile') });
    setBusy(true);
    const first = await post();
    const token = first.answer?.data?.confirmToken;
    if (first.failure || !token) {
      setBusy(false);
      return setMessage({ tone: 'error', text: first.failure ?? t('error') });
    }
    const ok = await askConfirm({
      object: t('change.confirmObject', {
        trn: normalizeTaxRegistrationNumber(trn),
        name: legalName.trim(),
      }),
      consequence: t('change.confirmConsequence'),
      confirmLabel: t('change.confirmLabel'),
      tone: 'default',
    });
    if (!ok) {
      setBusy(false);
      return;
    }
    const second = await post(token);
    setBusy(false);
    if (second.failure) return setMessage({ tone: 'error', text: second.failure });
    setOpen(false);
    setFile(null);
    setMessage({ tone: 'ok', text: t('change.sent') });
    await load();
  };

  const withdraw = async () => {
    setMessage(null);
    const { error } = await apiDelete(url);
    if (error) return setMessage({ tone: 'error', text: error.message || t('error') });
    setMessage({ tone: 'ok', text: t('change.withdrawn') });
    await load();
  };

  const pickFile = (f: File | null) => {
    if (f && !(TAX_DOCUMENT_MIME_TYPES as readonly string[]).includes(f.type))
      return setMessage({ tone: 'error', text: t('documents.invalidType') });
    if (f && f.size > TAX_DOCUMENT_MAX_BYTES)
      return setMessage({ tone: 'error', text: t('documents.tooLarge') });
    setMessage(null);
    setFile(f);
  };

  const inputCls =
    'w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground';
  return (
    <div data-testid="vat-change-request" className="space-y-3 border-t border-border pt-3">
      <div>
        <h3 data-setting-id="tax.change-request" className="text-sm font-medium text-foreground">
          {t('change.title')}
        </h3>
        <p className="text-xs text-muted-foreground">{t('change.hint')}</p>
      </div>
      {state?.lastRejection && !state.request && (
        <p role="status" className="text-sm text-destructive-ink">
          {t('change.rejected', { reason: state.lastRejection.reason })}
        </p>
      )}
      {state?.request ? (
        <div className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning-ink">
          <p className="font-medium">{t('change.pendingTitle')}</p>
          <p dir="auto">
            {t('change.pendingBody', {
              trn: state.request.taxRegistrationNumber,
              name: state.request.legalName,
            })}
          </p>
          <Button type="button" variant="outline" size="sm" onClick={withdraw} className="mt-2">
            {t('change.withdraw')}
          </Button>
        </div>
      ) : open ? (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-foreground">{t('change.newTrn')}</span>
              <input
                dir="ltr"
                inputMode="numeric"
                className={`${inputCls} text-start`}
                value={trn}
                placeholder={t('form.trnPlaceholder')}
                disabled={busy}
                onChange={e => setTrn(e.target.value)}
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-foreground">
                {t('change.newLegalName')}
              </span>
              <input
                className={inputCls}
                value={legalName}
                disabled={busy}
                onChange={e => setLegalName(e.target.value)}
              />
            </label>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <label className="block text-sm">
              <span className="mb-1 block text-xs font-medium text-foreground">
                {t('documents.kindLabel')}
              </span>
              <select
                className={inputCls}
                value={kind}
                disabled={busy}
                onChange={e => setKind(e.target.value as TaxDocumentKindValue)}
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
                {t('change.newDocument')}
              </span>
              <input
                type="file"
                accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
                className="text-sm"
                disabled={busy}
                onChange={e => pickFile(e.target.files?.[0] ?? null)}
              />
            </label>
          </div>
          <div className="flex gap-2">
            <Button type="button" size="sm" onClick={send} disabled={busy}>
              {busy ? t('change.sending') : t('change.send')}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setOpen(false)}
              disabled={busy}
            >
              {t('change.cancel')}
            </Button>
          </div>
        </div>
      ) : (
        <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
          {t('change.open')}
        </Button>
      )}
      {message && (
        <p
          role={message.tone === 'error' ? 'alert' : 'status'}
          className={`text-sm ${message.tone === 'error' ? 'text-destructive-ink' : 'text-success-ink'}`}
        >
          {message.text}
        </p>
      )}
    </div>
  );
}
