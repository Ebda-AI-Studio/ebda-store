'use client';

/**
 * Super-admin provider activation queue — /provider-activation.
 *
 * A merchant saves credentials for an unverified provider and requests activation. Ebda runs the
 * connection test here, then activates it for that store or rejects it with a note (the merchant
 * is emailed). Credentials are never shown or requested on this page.
 *
 * Route guard: super_admin only (RequireSuperAdmin + the API's role check).
 */

import { useCallback, useEffect, useState } from 'react';
import { useLocale } from 'next-intl';
import { Badge, Button, Modal, ModalBody, ModalFooter, useToast } from '@ebda/ui';
import { PROVIDER_CATALOG, withNumerals } from '@ebda/shared';
import { AdminLayout } from '../../components/AdminLayout';
import { RequireSuperAdmin } from '../../components/RequireSuperAdmin';
import { ProviderVerificationSection } from '../../components/ProviderVerificationSection';
import { DataTable, type DataTableColumn } from '../../components/mobile/DataTable';
import { apiGet, apiPost } from '../../lib/api';
import { useT } from '../../i18n/useT';
import { useLatestRequest } from '../../hooks/useLatestRequest';
import type { ActivationStatus } from '../../lib/provider-activation';

const TABS: ActivationStatus[] = ['requested', 'activated', 'rejected'];
const STATUS_VARIANT = {
  requested: 'warning',
  activated: 'success',
  rejected: 'destructive',
} as const;
const TEST_CODES = ['ok', 'bad_credentials', 'wrong_mode', 'incomplete', 'unreachable', 'unknown'];

interface LastTest {
  ok: boolean;
  code: string;
  mode: string;
  at: string;
  current: boolean;
}

interface ActivationRow {
  id: string;
  storeId: string;
  storeName: string;
  storeSlug: string;
  provider: string;
  kind: string;
  status: ActivationStatus;
  note: string | null;
  requestedAt: string;
  decidedAt: string | null;
  lastTest: LastTest | null;
}

const rowId = (r: ActivationRow) => `${r.storeId}:${r.provider}`;

function ActivationRequestsInner() {
  const t = useT('activationRequests');
  const locale = useLocale() === 'ar' ? 'ar' : 'en';
  const { success: toastSuccess, error: toastError } = useToast();
  const [tab, setTab] = useState<ActivationStatus>('requested');
  const [rows, setRows] = useState<ActivationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);

  const [rejecting, setRejecting] = useState<ActivationRow | null>(null);
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState(false);

  const fmt = (iso: string) =>
    new Date(iso).toLocaleString(locale === 'ar' ? 'ar-EG' : 'en-GB', withNumerals());
  const providerName = (code: string) =>
    PROVIDER_CATALOG.find(p => p.code === code)?.name[locale] ?? code;

  // Latest-request-wins: a slower response for a previous tab must not repaint its rows.
  const beginRequest = useLatestRequest();
  const fetchList = useCallback(async () => {
    const isLatest = beginRequest();
    setLoading(true);
    const { data, error } = await apiGet<{ requests: ActivationRow[] }>(
      `/api/v1/admin/provider-activation?status=${tab}`
    );
    if (!isLatest()) return;
    setLoadError(!!error);
    setRows(data?.requests ?? []);
    setLoading(false);
  }, [tab, beginRequest]);

  useEffect(() => {
    fetchList();
  }, [fetchList, refreshKey]);

  const base = (r: ActivationRow) => `/api/v1/admin/provider-activation/${r.storeId}/${r.provider}`;

  async function runTest(r: ActivationRow) {
    setBusy(rowId(r));
    const { error } = await apiPost(`${base(r)}/test`);
    setBusy(null);
    if (error) {
      toastError(t('actions.failed', { message: error.message }));
      return;
    }
    setRefreshKey(k => k + 1);
  }

  async function activate(r: ActivationRow) {
    setBusy(rowId(r));
    const { error } = await apiPost(`${base(r)}/activate`);
    setBusy(null);
    if (error) {
      toastError(
        error.code === 'CONNECTION_NOT_TESTED'
          ? t('actions.notTested')
          : t('actions.failed', { message: error.message })
      );
      return;
    }
    toastSuccess(t('actions.activated'));
    setRefreshKey(k => k + 1);
  }

  async function reject() {
    if (!rejecting) return;
    const trimmed = note.trim();
    if (trimmed.length < 3) return setNoteError(true);
    setNoteError(false);
    setBusy(rowId(rejecting));
    const { error } = await apiPost(`${base(rejecting)}/reject`, { note: trimmed });
    setBusy(null);
    if (error) {
      toastError(t('actions.failed', { message: error.message }));
      return;
    }
    toastSuccess(t('actions.rejected'));
    setRejecting(null);
    setNote('');
    setRefreshKey(k => k + 1);
  }

  const columns: DataTableColumn<ActivationRow>[] = [
    {
      header: t('columns.store'),
      primaryOnMobile: true,
      cell: r => (
        <div>
          <p className="font-medium text-foreground">{r.storeName}</p>
          <p dir="ltr" className="text-start text-xs text-muted-foreground">
            {r.storeSlug}
          </p>
        </div>
      ),
    },
    {
      header: t('columns.provider'),
      cell: r => <span className="text-foreground">{providerName(r.provider)}</span>,
    },
    {
      header: t('columns.kind'),
      hideOnMobile: true,
      cell: r => (
        <span className="text-muted-foreground">
          {r.kind === 'payments' || r.kind === 'shipping' ? t(`kind.${r.kind}`) : r.kind}
        </span>
      ),
    },
    {
      header: t('columns.requested'),
      hideOnMobile: true,
      cell: r => <span className="text-muted-foreground">{fmt(r.requestedAt)}</span>,
    },
    {
      header: t('columns.status'),
      mobileBadge: true,
      cell: r => (
        <div>
          <Badge variant={STATUS_VARIANT[r.status]}>{t(`status.${r.status}`)}</Badge>
          {r.status === 'rejected' && r.note && (
            <p className="mt-1 max-w-[220px] text-xs text-muted-foreground">{r.note}</p>
          )}
        </div>
      ),
    },
    {
      header: t('columns.lastTest'),
      cell: r =>
        r.lastTest ? (
          <div className="text-xs">
            <Badge variant={r.lastTest.ok ? 'success' : 'destructive'}>
              {r.lastTest.ok ? t('test.ok') : t('test.failed')}
            </Badge>
            <p dir="ltr" className="mt-1 text-start text-muted-foreground">
              {TEST_CODES.includes(r.lastTest.code) ? r.lastTest.code : t('unknown')} ·{' '}
              {r.lastTest.mode}
            </p>
            <p className="text-muted-foreground">{fmt(r.lastTest.at)}</p>
            {!r.lastTest.current && <p className="text-warning-ink">{t('test.stale')}</p>}
          </div>
        ) : (
          <span className="text-muted-foreground">{t('test.never')}</span>
        ),
    },
    {
      header: t('columns.actions'),
      mobileActions: true,
      cell: r => {
        const working = busy === rowId(r);
        const canActivate = Boolean(r.lastTest?.ok && r.lastTest.current);
        return (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={working} onClick={() => runTest(r)}>
              {t('actions.runTest')}
            </Button>
            {r.status !== 'activated' && (
              <Button size="sm" disabled={working || !canActivate} onClick={() => activate(r)}>
                {t('actions.activate')}
              </Button>
            )}
            {r.status !== 'rejected' && (
              <Button
                size="sm"
                variant="outline"
                disabled={working}
                onClick={() => {
                  setRejecting(r);
                  setNote('');
                  setNoteError(false);
                }}
              >
                {t('actions.reject')}
              </Button>
            )}
          </div>
        );
      },
    },
  ];

  return (
    <div className="p-4 sm:p-6">
      <div role="tablist" className="mb-4 flex flex-wrap gap-2">
        {TABS.map(k => (
          <button
            key={k}
            role="tab"
            type="button"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            className={`rounded-full border px-3 py-1 text-sm ${
              tab === k
                ? 'border-primary bg-primary/10 text-primary-ink'
                : 'border-border text-muted-foreground hover:bg-muted'
            }`}
          >
            {t(`status.${k}`)}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="rounded-lg border border-border px-3 py-6 text-center text-muted-foreground">
          {t('loading')}
        </div>
      ) : (
        <DataTable<ActivationRow>
          ariaLabel={t('title')}
          columns={columns}
          rows={rows}
          rowKey={rowId}
          emptyState={
            loadError ? (
              <div
                role="alert"
                className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-6 text-center text-destructive-ink"
              >
                {t('loadFailed')}
              </div>
            ) : (
              <div className="rounded-lg border border-border px-3 py-6 text-center text-muted-foreground">
                {t('empty')}
              </div>
            )
          }
        />
      )}

      <Modal
        isOpen={rejecting !== null}
        onClose={() => setRejecting(null)}
        title={
          rejecting
            ? t('rejectDialog.title', {
                store: rejecting.storeName,
                provider: providerName(rejecting.provider),
              })
            : ''
        }
        size="md"
      >
        <ModalBody>
          <label className="block text-sm">
            <span className="mb-1 block font-medium">{t('rejectDialog.noteLabel')}</span>
            <textarea
              aria-label={t('rejectDialog.noteLabel')}
              className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm"
              rows={3}
              maxLength={1000}
              value={note}
              onChange={e => setNote(e.target.value)}
            />
          </label>
          <p className="mt-1 text-xs text-muted-foreground">{t('rejectDialog.emailNote')}</p>
          {noteError && (
            <p role="alert" className="mt-1 text-sm text-destructive-ink">
              {t('rejectDialog.noteRequired')}
            </p>
          )}
        </ModalBody>
        <ModalFooter>
          <Button variant="outline" onClick={() => setRejecting(null)} disabled={busy !== null}>
            {t('rejectDialog.cancel')}
          </Button>
          <Button onClick={reject} disabled={busy !== null}>
            {busy !== null ? t('rejectDialog.working') : t('actions.reject')}
          </Button>
        </ModalFooter>
      </Modal>
    </div>
  );
}

export default function ProviderActivationPage() {
  const t = useT('activationRequests');
  return (
    <AdminLayout title={t('title')} subtitle={t('subtitle')} mode="super_admin">
      <RequireSuperAdmin>
        <ProviderVerificationSection />
        <ActivationRequestsInner />
      </RequireSuperAdmin>
    </AdminLayout>
  );
}
