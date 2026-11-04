'use client';

/**
 * Super-admin VAT verification queue — /tax-verification (ruling TAX-2).
 *
 * A merchant may charge VAT only after a super-admin verifies the VAT
 * registration (TRN + tax card / certificate). This page lists submissions and
 * lets the reviewer open each document, then approve, reject or revoke.
 *
 * Route guard: super_admin only (RequireSuperAdmin + the API's requireRole).
 */

import { useCallback, useEffect, useState } from 'react';
import { useLocale } from 'next-intl';
import { Badge, Button, Modal, ModalBody, ModalFooter, useToast } from '@ebda/ui';
import type { TaxProfileStatusValue } from '@ebda/shared';
import { AdminLayout } from '../../components/AdminLayout';
import { RequireSuperAdmin } from '../../components/RequireSuperAdmin';
import { DataTable, type DataTableColumn } from '../../components/mobile/DataTable';
import { apiGet, apiPost } from '../../lib/api';
import { openProtectedDocument } from '../../lib/open-document';
import { useT } from '../../i18n/useT';
import { useConfirm } from '@/hooks/useConfirm';
import { withNumerals } from '@ebda/shared';

type Tab = 'pending' | 'verified' | 'rejected' | 'revoked' | 'all';
const TABS: Tab[] = ['pending', 'verified', 'rejected', 'revoked', 'all'];

interface ReviewRow {
  storeId: string;
  storeName: string;
  storeSlug: string;
  status: Exclude<TaxProfileStatusValue, 'none'>;
  taxRegistrationNumber: string | null;
  legalName: string | null;
  submittedAt: string | null;
  reviewedAt: string | null;
  verifiedAt: string | null;
  rejectionReason: string | null;
  documentCount: number;
  duplicateTrnStores: number | unknown[] | null;
}

interface ReviewDocument {
  id: string;
  kind: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}

interface ReviewDetail {
  status: TaxProfileStatusValue;
  taxRegistrationNumber: string | null;
  legalName: string | null;
  rejectionReason: string | null;
  documents: ReviewDocument[];
}

const STATUS_VARIANT = {
  pending: 'warning',
  verified: 'success',
  rejected: 'destructive',
  revoked: 'destructive',
} as const;

function duplicateCount(v: ReviewRow['duplicateTrnStores']): number {
  if (Array.isArray(v)) return v.length;
  return typeof v === 'number' ? v : 0;
}

function TaxVerificationInner() {
  const t = useT('taxReview');
  const askConfirm = useConfirm();
  const locale = useLocale();
  const { success: toastSuccess, error: toastError } = useToast();
  const [tab, setTab] = useState<Tab>('pending');
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const [selected, setSelected] = useState<ReviewRow | null>(null);
  const [detail, setDetail] = useState<ReviewDetail | null>(null);
  const [detailError, setDetailError] = useState(false);
  const [mode, setMode] = useState<null | 'reject' | 'revoke'>(null);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState(false);
  const [working, setWorking] = useState(false);

  const fmt = (iso: string | null) =>
    iso
      ? new Date(iso).toLocaleDateString(locale === 'ar' ? 'ar-EG' : 'en-GB', withNumerals())
      : '—';

  const fetchList = useCallback(async () => {
    setLoading(true);
    const qs = tab === 'all' ? '' : `?status=${tab}`;
    const { data, error } = await apiGet<{ profiles: ReviewRow[] }>(
      `/api/v1/admin/tax-verification${qs}`
    );
    setLoadError(!!error);
    setRows(data?.profiles ?? []);
    setLoading(false);
  }, [tab]);

  useEffect(() => {
    fetchList();
  }, [fetchList]);

  const open = async (row: ReviewRow) => {
    setSelected(row);
    setDetail(null);
    setDetailError(false);
    setMode(null);
    setReason('');
    setReasonError(false);
    const { data, error } = await apiGet<{ profile: ReviewDetail }>(
      `/api/v1/admin/tax-verification/${row.storeId}`
    );
    if (error || !data?.profile) setDetailError(true);
    else setDetail(data.profile);
  };

  const close = () => {
    setSelected(null);
    setDetail(null);
    setMode(null);
  };

  const viewDoc = async (doc: ReviewDocument) => {
    if (!selected) return;
    const ok = await openProtectedDocument(
      `/api/v1/admin/tax-verification/${selected.storeId}/documents/${doc.id}/file`
    );
    if (!ok) toastError(t('detail.openFailed'));
  };

  const decide = async (decision: 'approve' | 'reject' | 'revoke') => {
    if (!selected) return;
    const needsReason = decision !== 'approve';
    const trimmed = reason.trim();
    if (needsReason && trimmed.length < 3) return setReasonError(true);
    if (decision === 'revoke') {
      const ok = await askConfirm({
        object: t('actions.revokeObject'),
        consequence: t('actions.revokeConfirm'),
        confirmLabel: t('actions.revoke'),
      });
      if (!ok) return;
    }
    setReasonError(false);
    setWorking(true);
    const { error } = await apiPost(
      `/api/v1/admin/tax-verification/${selected.storeId}/decision`,
      needsReason ? { decision, reason: trimmed } : { decision }
    );
    setWorking(false);
    if (error) {
      toastError(t('actions.failed', { message: error.message }));
      return;
    }
    toastSuccess(
      decision === 'approve'
        ? t('actions.approved')
        : decision === 'reject'
          ? t('actions.rejected')
          : t('actions.revoked')
    );
    close();
    await fetchList();
  };

  const columns: DataTableColumn<ReviewRow>[] = [
    {
      header: t('columns.store'),
      primaryOnMobile: true,
      cell: r => <span className="font-medium text-foreground">{r.storeName}</span>,
    },
    {
      header: t('columns.trn'),
      cell: r => (
        <span dir="ltr" className="font-mono text-sm">
          {r.taxRegistrationNumber ?? '—'}
          {duplicateCount(r.duplicateTrnStores) > 0 && (
            <Badge variant="warning" className="ms-2">
              {t('duplicate', { count: duplicateCount(r.duplicateTrnStores) })}
            </Badge>
          )}
        </span>
      ),
    },
    {
      header: t('columns.legalName'),
      cell: r => <span className="text-muted-foreground">{r.legalName ?? '—'}</span>,
    },
    {
      header: t('columns.submitted'),
      hideOnMobile: true,
      cell: r => <span className="text-muted-foreground">{fmt(r.submittedAt)}</span>,
    },
    {
      header: t('columns.docs'),
      hideOnMobile: true,
      cell: r => <span>{r.documentCount}</span>,
    },
    {
      header: t('columns.status'),
      mobileBadge: true,
      cell: r => <Badge variant={STATUS_VARIANT[r.status]}>{t(`status.${r.status}`)}</Badge>,
    },
    {
      header: t('columns.actions'),
      cell: r => (
        <Button size="sm" variant="outline" onClick={() => open(r)}>
          {t('review')}
        </Button>
      ),
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
            {t(`tabs.${k}`)}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="rounded-lg border border-border px-3 py-6 text-center text-muted-foreground">
          {t('loading')}
        </div>
      ) : (
        <DataTable<ReviewRow>
          ariaLabel={t('title')}
          columns={columns}
          rows={rows}
          rowKey={r => r.storeId}
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
        isOpen={selected !== null}
        onClose={close}
        title={selected ? t('detail.title', { store: selected.storeName }) : ''}
        size="lg"
      >
        <ModalBody>
          {detailError && (
            <p role="alert" className="text-sm text-destructive-ink">
              {t('detail.loadFailed')}
            </p>
          )}
          {detail && (
            <div className="space-y-4 text-sm">
              <dl className="grid gap-2 sm:grid-cols-2">
                <div>
                  <dt className="text-xs text-muted-foreground">{t('columns.trn')}</dt>
                  <dd dir="ltr" className="font-mono text-start">
                    {detail.taxRegistrationNumber ?? '—'}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">{t('columns.legalName')}</dt>
                  <dd>{detail.legalName ?? '—'}</dd>
                </div>
              </dl>
              {detail.rejectionReason && (
                <p className="text-muted-foreground">
                  {t('detail.rejectionReason', { reason: detail.rejectionReason })}
                </p>
              )}
              <div>
                <h3 className="mb-1 font-medium">{t('detail.documents')}</h3>
                {detail.documents.length === 0 ? (
                  <p className="text-muted-foreground">{t('detail.noDocuments')}</p>
                ) : (
                  <ul className="divide-y divide-border rounded-md border border-border">
                    {detail.documents.map(d => (
                      <li key={d.id} className="flex items-center justify-between gap-2 px-3 py-2">
                        <span className="min-w-0 break-all" dir="auto">
                          {d.kind} · {d.fileName}
                        </span>
                        <button
                          type="button"
                          onClick={() => viewDoc(d)}
                          className="text-primary hover:underline"
                        >
                          {t('detail.view')}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              {mode && (
                <div>
                  <label className="block">
                    <span className="mb-1 block font-medium">{t('detail.reasonLabel')}</span>
                    <textarea
                      aria-label={t('detail.reasonLabel')}
                      className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm"
                      rows={3}
                      maxLength={1000}
                      value={reason}
                      onChange={e => setReason(e.target.value)}
                    />
                  </label>
                  {reasonError && (
                    <p role="alert" className="text-destructive-ink">
                      {t('detail.reasonRequired')}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
        </ModalBody>
        <ModalFooter>
          <Button variant="outline" onClick={mode ? () => setMode(null) : close} disabled={working}>
            {mode ? t('actions.cancel') : t('detail.close')}
          </Button>
          {detail && !mode && selected?.status === 'pending' && (
            <>
              <Button variant="outline" onClick={() => setMode('reject')} disabled={working}>
                {t('actions.reject')}
              </Button>
              <Button onClick={() => decide('approve')} disabled={working}>
                {working ? t('actions.working') : t('actions.approve')}
              </Button>
            </>
          )}
          {detail && !mode && selected?.status === 'verified' && (
            <Button variant="outline" onClick={() => setMode('revoke')} disabled={working}>
              {t('actions.revoke')}
            </Button>
          )}
          {detail && mode && (
            <Button onClick={() => decide(mode)} disabled={working}>
              {working
                ? t('actions.working')
                : mode === 'reject'
                  ? t('actions.confirmReject')
                  : t('actions.confirmRevoke')}
            </Button>
          )}
        </ModalFooter>
      </Modal>
    </div>
  );
}

export default function TaxVerificationPage() {
  const t = useT('taxReview');
  return (
    <AdminLayout title={t('title')} subtitle={t('subtitle')} mode="super_admin">
      <RequireSuperAdmin>
        <TaxVerificationInner />
      </RequireSuperAdmin>
    </AdminLayout>
  );
}
