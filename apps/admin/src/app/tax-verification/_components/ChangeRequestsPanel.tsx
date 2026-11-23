'use client';

import { useCallback, useEffect, useState } from 'react';
import { Badge, useToast } from '@ebda/ui';
import { Button } from '@/components/ui/Button';
import { apiGet, apiPost } from '../../../lib/api';
import { openProtectedDocument } from '../../../lib/open-document';
import { useT } from '../../../i18n/useT';
import { useConfirm } from '@/hooks/useConfirm';

interface ChangeRow {
  /** The request the reviewer is looking at: the decision names it (id + document sha256 + number) or the server refuses. */
  id: string;
  sha256: string;
  storeId: string;
  taxRegistrationNumber: string;
  legalName: string;
  fileName: string;
  requestedAt: string;
  precheck: {
    status: 'clean' | 'flagged';
    flags: string[];
    extracted: { taxRegistrationNumber: string | null; legalName: string | null } | null;
  };
}

/**
 * Pending changes of VERIFIED registrations (self-service A10). The pre-check is a read of the document by AI plus a plain
 * comparison; it only informs. Approve / reject is the reviewer's, and the merchant stays verified meanwhile.
 */
export function ChangeRequestsPanel() {
  const t = useT('taxReview');
  const askConfirm = useConfirm();
  const { success: toastSuccess, error: toastError } = useToast();
  const [rows, setRows] = useState<ChangeRow[]>([]);
  const [reasonFor, setReasonFor] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const load = useCallback(async () => {
    const { data } = await apiGet<{ requests: ChangeRow[] }>(
      '/api/v1/admin/tax-verification/change-requests'
    );
    setRows(data?.requests ?? []);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (rows.length === 0) return null;

  const decide = async (r: ChangeRow, decision: 'approve' | 'reject') => {
    if (decision === 'reject' && reason.trim().length < 3) return;
    if (decision === 'approve') {
      const ok = await askConfirm({
        object: t('changes.approveObject', { trn: r.taxRegistrationNumber, name: r.legalName }),
        consequence: t('changes.approveConsequence'),
        confirmLabel: t('changes.approve'),
        tone: 'default',
      });
      if (!ok) return;
    }
    const { error } = await apiPost(`/api/v1/admin/tax-verification/${r.storeId}/change-decision`, {
      decision,
      requestId: r.id,
      sha256: r.sha256,
      taxRegistrationNumber: r.taxRegistrationNumber,
      ...(decision === 'reject' ? { reason: reason.trim() } : {}),
    });
    if (error) {
      toastError(t('actions.failed', { message: error.message }));
      await load(); // a request replaced since the list loaded: show the current one
      return;
    }
    toastSuccess(decision === 'approve' ? t('changes.approved') : t('changes.rejected'));
    setReasonFor(null);
    setReason('');
    await load();
  };

  return (
    <section
      aria-labelledby="tax-changes-title"
      className="mb-4 space-y-3 rounded-xl border border-border bg-card p-4"
    >
      <div>
        <h2 id="tax-changes-title" className="text-base font-semibold text-foreground">
          {t('changes.title', { count: rows.length })}
        </h2>
        <p className="text-sm text-muted-foreground">{t('changes.subtitle')}</p>
      </div>
      <ul className="divide-y divide-border">
        {rows.map(r => (
          <li key={r.storeId} className="space-y-2 py-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span dir="ltr" className="font-mono">
                {r.taxRegistrationNumber}
              </span>
              <span dir="auto" className="text-foreground">
                {r.legalName}
              </span>
              <Badge variant={r.precheck.status === 'clean' ? 'success' : 'warning'}>
                {t(`changes.precheck.${r.precheck.status}`)}
              </Badge>
            </div>
            {r.precheck.flags.length > 0 && (
              <ul className="list-disc ps-5 text-warning-ink">
                {r.precheck.flags.map(f => (
                  <li key={f}>{t(`changes.flags.${f}`)}</li>
                ))}
              </ul>
            )}
            {r.precheck.extracted && (
              <p className="text-xs text-muted-foreground" dir="auto">
                {t('changes.read', {
                  trn: r.precheck.extracted.taxRegistrationNumber ?? '—',
                  name: r.precheck.extracted.legalName ?? '—',
                })}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  const ok = await openProtectedDocument(
                    `/api/v1/admin/tax-verification/${r.storeId}/change-request/file`
                  );
                  if (!ok) toastError(t('detail.openFailed'));
                }}
              >
                {t('changes.viewDocument')}
              </Button>
              <Button size="sm" onClick={() => decide(r, 'approve')}>
                {t('changes.approve')}
              </Button>
              <Button variant="outline" size="sm" onClick={() => setReasonFor(r.storeId)}>
                {t('changes.reject')}
              </Button>
            </div>
            {reasonFor === r.storeId && (
              <div className="flex flex-wrap items-center gap-2">
                <input
                  className="min-w-64 rounded-md border border-border bg-background px-3 py-1.5 text-sm"
                  aria-label={t('changes.reasonLabel')}
                  placeholder={t('changes.reasonLabel')}
                  value={reason}
                  onChange={e => setReason(e.target.value)}
                />
                <Button
                  size="sm"
                  onClick={() => decide(r, 'reject')}
                  disabled={reason.trim().length < 3}
                >
                  {t('changes.confirmReject')}
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
