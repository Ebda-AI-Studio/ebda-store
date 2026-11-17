'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Modal, useToast } from '@ebda/ui';
import { Button } from '@/components/ui/Button';
import { WEBHOOK_EVENT_TYPES, withNumerals, type WebhookEventType } from '@ebda/shared';
import { AdminLayout } from '../../../../components/AdminLayout';
import { apiDelete, apiGet, apiPatch, apiPost, type ApiError } from '../../../../lib/api';
import { useT } from '@/i18n/useT';
import { useLocale } from 'next-intl';
import { planNamesJoined } from '@/lib/plan-labels';

/**
 * Merchant outgoing webhooks: endpoints, the once-only signing secret, the delivery log with
 * resend, and "send test event". Plan: docs/plans/done/2026-10-21-merchant-webhooks.md.
 *
 * The secret exists in this browser only in `secret` state while the reveal modal is open: never
 * in storage or the URL, and the list API never returns it. A lost secret is replaced, not read.
 */

interface Endpoint {
  id: string;
  url: string;
  description: string | null;
  events: WebhookEventType[];
  includeCustomer: boolean;
  secretHint: string;
  active: boolean;
  disabledReason: string | null;
  consecutiveFailures: number;
  lastSuccessAt: string | null;
}

interface Delivery {
  id: string;
  eventType: string;
  status: 'pending' | 'retrying' | 'success' | 'failed';
  attempts: number;
  isTest: boolean;
  responseStatus: number | null;
  responseSnippet: string | null;
  error: string | null;
  createdAt: string;
}

const EMPTY_FORM = {
  url: '',
  description: '',
  events: [] as WebhookEventType[],
  includeCustomer: false,
};

export default function WebhooksPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const t = useT('webhooks');
  const locale = useLocale() === 'ar' ? 'ar' : 'en';
  const plans = planNamesJoined(['growth', 'business'], locale);
  const { success: toastSuccess, error: toastError } = useToast();
  const base = `/api/v1/stores/${storeId}/webhooks`;

  const [endpoints, setEndpoints] = useState<Endpoint[] | null>(null);
  const [needsUpgrade, setNeedsUpgrade] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Endpoint | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);

  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [rotateTarget, setRotateTarget] = useState<Endpoint | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Endpoint | null>(null);

  const [logFor, setLogFor] = useState<Endpoint | null>(null);
  const [log, setLog] = useState<Delivery[] | null>(null);

  const errText = useCallback(
    (e: ApiError) =>
      e.status === 402
        ? t('plan.title', { plans })
        : e.code === 'WEBHOOK_URL_REJECTED' || e.code === 'WEBHOOK_LIMIT'
          ? t(`error.${e.code}`)
          : e.message,
    [t]
  );

  const load = useCallback(async () => {
    if (!storeId) return;
    const { data, error } = await apiGet<{ endpoints: Endpoint[] }>(base);
    if (error) {
      if (error.status === 402) setNeedsUpgrade(true);
      else toastError(t('toast.loadFailedTitle'), error.message);
      return;
    }
    if (data) setEndpoints(data.endpoints);
  }, [storeId, base, toastError, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadLog = useCallback(
    async (ep: Endpoint) => {
      const { data, error } = await apiGet<{ deliveries: Delivery[] }>(
        `${base}/${ep.id}/deliveries`
      );
      if (error) {
        toastError(t('toast.loadFailedTitle'), error.message);
        return;
      }
      setLog(data?.deliveries ?? []);
    },
    [base, toastError, t]
  );

  const openForm = (ep: Endpoint | null) => {
    setEditing(ep);
    setFormError(null);
    setForm(
      ep
        ? {
            url: ep.url,
            description: ep.description ?? '',
            events: ep.events,
            includeCustomer: ep.includeCustomer,
          }
        : EMPTY_FORM
    );
    setFormOpen(true);
  };

  const save = async () => {
    setBusy('save');
    setFormError(null);
    const body = {
      url: form.url.trim(),
      description: form.description.trim() || null,
      events: form.events,
      includeCustomer: form.includeCustomer,
    };
    const res = editing
      ? await apiPatch<{ endpoint: Endpoint }>(`${base}/${editing.id}`, body)
      : await apiPost<{ endpoint: Endpoint; secret: string }>(base, body);
    setBusy(null);
    if (res.error) {
      setFormError(errText(res.error));
      return;
    }
    setFormOpen(false);
    toastSuccess(t('toast.saved'));
    const created = res.data as { secret?: string } | null;
    if (!editing && created?.secret) {
      setCopied(false);
      setSecret(created.secret);
    }
    await load();
  };

  const setActive = async (ep: Endpoint, active: boolean) => {
    setBusy(ep.id);
    const { error } = await apiPatch(`${base}/${ep.id}`, { active });
    setBusy(null);
    if (error) toastError(t('toast.saveFailedTitle'), errText(error));
    await load();
  };

  const rotate = async (ep: Endpoint) => {
    setBusy(ep.id);
    const { data, error } = await apiPost<{ secret: string }>(`${base}/${ep.id}/rotate-secret`);
    setBusy(null);
    setRotateTarget(null);
    if (error || !data) {
      toastError(t('toast.rotateFailedTitle'), error?.message);
      return;
    }
    toastSuccess(t('toast.rotated'));
    setCopied(false);
    setSecret(data.secret);
    await load();
  };

  const remove = async (ep: Endpoint) => {
    setBusy(ep.id);
    const { error } = await apiDelete(`${base}/${ep.id}`);
    setBusy(null);
    setDeleteTarget(null);
    if (error) {
      toastError(t('toast.deleteFailedTitle'), error.message);
      return;
    }
    toastSuccess(t('toast.deleted'));
    await load();
  };

  const sendTest = async (ep: Endpoint) => {
    setBusy(ep.id);
    const { error } = await apiPost(`${base}/${ep.id}/test`);
    setBusy(null);
    if (error) {
      toastError(t('toast.testFailedTitle'), error.message);
      return;
    }
    toastSuccess(t('toast.testQueued'));
    if (logFor?.id === ep.id) setTimeout(() => void loadLog(ep), 3000);
  };

  const resend = async (ep: Endpoint, d: Delivery) => {
    setBusy(d.id);
    const { error } = await apiPost(`${base}/${ep.id}/deliveries/${d.id}/resend`);
    setBusy(null);
    if (error) {
      toastError(t('toast.resendFailedTitle'), error.message);
      return;
    }
    toastSuccess(t('toast.resent'));
    setTimeout(() => void loadLog(ep), 3000);
  };

  const copySecret = async () => {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const toggleEvent = (ev: WebhookEventType) =>
    setForm(f => ({
      ...f,
      events: f.events.includes(ev) ? f.events.filter(x => x !== ev) : [...f.events, ev],
    }));

  const fmt = (v: string | null) =>
    v ? new Date(v).toLocaleString(undefined, withNumerals()) : t('table.never');
  const badge = 'rounded px-1.5 py-0.5 text-xs font-medium';

  return (
    <AdminLayout
      title={t('page.title')}
      subtitle={t('page.subtitle')}
      actions={
        !needsUpgrade ? (
          <Button type="button" onClick={() => openForm(null)}>
            {t('actions.add')}
          </Button>
        ) : null
      }
    >
      <div className="space-y-4">
        {needsUpgrade ? (
          <div className="rounded-lg border bg-card p-4">
            <h2 className="text-sm font-semibold text-foreground" dir="auto">
              {t('plan.title', { plans })}
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground" dir="auto">
              {t('plan.body')}
            </p>
            <Link href={`/stores/${storeId}/billing`} className="mt-3 inline-block">
              <Button type="button" size="sm">
                {t('plan.cta')}
              </Button>
            </Link>
          </div>
        ) : (
          <>
            <div className="rounded-lg border bg-card p-4">
              <h2 className="text-sm font-semibold text-foreground" dir="auto">
                {t('intro.heading')}
              </h2>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground" dir="auto">
                {t('intro.body')}
              </p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground" dir="auto">
                {t('intro.pii')}
              </p>
            </div>

            {endpoints && endpoints.length === 0 ? (
              <div className="rounded-lg border border-dashed p-8 text-center">
                <p className="text-sm text-muted-foreground" dir="auto">
                  {t('empty.body')}
                </p>
              </div>
            ) : null}

            {endpoints?.map(ep => (
              <div key={ep.id} className="space-y-2 rounded-lg border bg-card p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <code className="font-mono text-xs break-all text-foreground" dir="ltr">
                    {ep.url}
                  </code>
                  <span
                    className={`${badge} ${
                      ep.active
                        ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300'
                        : 'bg-muted text-muted-foreground'
                    }`}
                    dir="auto"
                  >
                    {ep.active ? t('status.active') : t('status.off')}
                  </span>
                </div>
                {ep.description ? (
                  <p className="text-xs text-muted-foreground" dir="auto">
                    {ep.description}
                  </p>
                ) : null}
                {!ep.active && ep.disabledReason === 'consecutive_failures' ? (
                  <p
                    className="rounded-lg border border-warning/40 bg-warning/10 p-2 text-xs text-warning-ink"
                    dir="auto"
                  >
                    {t('status.autoOff')}
                  </p>
                ) : null}
                <div className="flex flex-wrap gap-1">
                  {ep.events.map(ev => (
                    <span key={ev} className={`${badge} bg-muted text-foreground`} dir="auto">
                      {t(`events.${ev.replace('.', '_')}`)}
                    </span>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground" dir="auto">
                  {t('table.lastSuccess')}: {fmt(ep.lastSuccessAt)}
                  {ep.consecutiveFailures > 0
                    ? ` · ${t('status.failures', { count: String(ep.consecutiveFailures) })}`
                    : ''}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="max-md:min-h-11"
                    onClick={() => openForm(ep)}
                  >
                    {t('actions.edit')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="max-md:min-h-11"
                    disabled={busy !== null}
                    onClick={() => void sendTest(ep)}
                  >
                    {t('actions.test')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="max-md:min-h-11"
                    onClick={() => {
                      setLogFor(ep);
                      setLog(null);
                      void loadLog(ep);
                    }}
                  >
                    {t('actions.deliveries')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="max-md:min-h-11"
                    disabled={busy !== null}
                    onClick={() => void setActive(ep, !ep.active)}
                  >
                    {ep.active ? t('actions.disable') : t('actions.enable')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="max-md:min-h-11"
                    onClick={() => setRotateTarget(ep)}
                  >
                    {t('actions.rotate')} ({'…'}
                    {ep.secretHint})
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="max-md:min-h-11"
                    onClick={() => setDeleteTarget(ep)}
                  >
                    {t('actions.delete')}
                  </Button>
                </div>
              </div>
            ))}
          </>
        )}
      </div>

      {/* Add / edit */}
      <Modal
        isOpen={formOpen}
        onClose={() => setFormOpen(false)}
        title={editing ? t('form.editTitle') : t('form.addTitle')}
      >
        <div className="space-y-3">
          <label className="block text-xs font-medium text-foreground" dir="auto">
            {t('form.urlLabel')}
            <input
              className="mt-1 w-full rounded-lg border bg-background px-3 py-2 text-sm"
              value={form.url}
              onChange={e => setForm(f => ({ ...f, url: e.target.value }))}
              placeholder={t('form.urlPlaceholder')}
              maxLength={2048}
              dir="ltr"
              inputMode="url"
            />
            <span className="mt-1 block text-xs font-normal text-muted-foreground">
              {t('form.urlHelp')}
            </span>
          </label>
          <label className="block text-xs font-medium text-foreground" dir="auto">
            {t('form.descriptionLabel')}
            <input
              className="mt-1 w-full rounded-lg border bg-background px-3 py-2 text-sm"
              value={form.description}
              onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              maxLength={120}
              dir="auto"
            />
          </label>
          <fieldset className="space-y-1">
            <legend className="text-xs font-medium text-foreground" dir="auto">
              {t('form.eventsLabel')}
            </legend>
            {WEBHOOK_EVENT_TYPES.map(ev => (
              <label
                key={ev}
                className="flex items-center gap-2 text-xs max-md:min-h-11"
                dir="auto"
              >
                <input
                  type="checkbox"
                  checked={form.events.includes(ev)}
                  onChange={() => toggleEvent(ev)}
                />
                <span>{t(`events.${ev.replace('.', '_')}`)}</span>
              </label>
            ))}
          </fieldset>
          <label className="flex items-start gap-2 text-xs" dir="auto">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={form.includeCustomer}
              onChange={e => setForm(f => ({ ...f, includeCustomer: e.target.checked }))}
            />
            <span>
              {t('form.customerLabel')}
              <span className="block text-muted-foreground">{t('form.customerHelp')}</span>
            </span>
          </label>
          {formError ? (
            <p className="text-xs text-foreground" role="alert" dir="auto">
              {formError}
            </p>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setFormOpen(false)}
              disabled={busy !== null}
            >
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => void save()}
              isLoading={busy === 'save'}
              disabled={busy !== null || form.url.trim().length === 0 || form.events.length === 0}
            >
              {t('form.save')}
            </Button>
          </div>
        </div>
      </Modal>

      {/* One-time secret */}
      <Modal
        isOpen={secret !== null}
        onClose={() => setSecret(null)}
        title={t('secret.title')}
        size="lg"
      >
        <div className="space-y-3">
          <p
            className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs leading-relaxed text-warning-ink"
            dir="auto"
          >
            {t('secret.warning')}
          </p>
          <code
            className="block w-full rounded-lg border bg-muted px-3 py-2 font-mono text-xs break-all text-foreground"
            dir="ltr"
          >
            {secret}
          </code>
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => void copySecret()}>
              {copied ? t('secret.copied') : t('secret.copy')}
            </Button>
            <Button type="button" size="sm" onClick={() => setSecret(null)}>
              {t('secret.done')}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Rotate */}
      <Modal
        isOpen={rotateTarget !== null}
        onClose={() => setRotateTarget(null)}
        title={t('rotate.title')}
      >
        <div className="space-y-3">
          <p className="text-xs leading-relaxed text-foreground" dir="auto">
            {t('rotate.body')}
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setRotateTarget(null)}
              disabled={busy !== null}
            >
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => rotateTarget && void rotate(rotateTarget)}
              isLoading={busy === rotateTarget?.id}
              disabled={busy !== null}
            >
              {t('rotate.confirm')}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Delete */}
      <Modal
        isOpen={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title={t('delete.title')}
      >
        <div className="space-y-3">
          <p
            className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs leading-relaxed text-foreground"
            dir="auto"
          >
            {t('delete.body', { url: deleteTarget?.url ?? '' })}
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setDeleteTarget(null)}
              disabled={busy !== null}
            >
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              onClick={() => deleteTarget && void remove(deleteTarget)}
              isLoading={busy === deleteTarget?.id}
              disabled={busy !== null}
            >
              {t('delete.confirm')}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Delivery log */}
      <Modal
        isOpen={logFor !== null}
        onClose={() => setLogFor(null)}
        title={t('log.title')}
        size="lg"
      >
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground" dir="auto">
            {t('log.subtitle', { count: '50' })}
          </p>
          {log && log.length === 0 ? (
            <p className="text-sm text-muted-foreground" dir="auto">
              {t('log.empty')}
            </p>
          ) : null}
          <ul className="space-y-2">
            {log?.map(d => (
              <li key={d.id} className="rounded-lg border p-2 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-foreground" dir="auto">
                    {t(`events.${d.eventType}`)}
                    {d.isTest ? ` · ${t('log.test')}` : ''}
                  </span>
                  <span
                    className={`${badge} ${
                      d.status === 'success'
                        ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300'
                        : d.status === 'failed'
                          ? 'border border-destructive/40 bg-destructive/5 text-foreground'
                          : 'bg-muted text-muted-foreground'
                    }`}
                    dir="auto"
                  >
                    {t(`log.${d.status === 'retrying' ? 'retrying' : d.status}`)}
                  </span>
                </div>
                <p className="mt-1 text-muted-foreground" dir="auto">
                  {fmt(d.createdAt)} · {t('log.attempts')}: {d.attempts}
                  {d.responseStatus
                    ? ` · ${t('log.code', { status: String(d.responseStatus) })}`
                    : ''}
                  {d.error ? ` · ${d.error}` : ''}
                </p>
                {d.responseSnippet ? (
                  <code
                    className="mt-1 block font-mono text-xs break-all text-muted-foreground"
                    dir="ltr"
                  >
                    {d.responseSnippet}
                  </code>
                ) : null}
                <div className="mt-1 flex justify-end">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="max-md:min-h-11"
                    disabled={busy !== null}
                    onClick={() => logFor && void resend(logFor, d)}
                  >
                    {t('actions.resend')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
          <div className="flex justify-end">
            <Button type="button" size="sm" onClick={() => setLogFor(null)}>
              {t('actions.close')}
            </Button>
          </div>
        </div>
      </Modal>
    </AdminLayout>
  );
}
