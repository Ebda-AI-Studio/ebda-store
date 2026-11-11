'use client';

/**
 * /stores/[id]/wholesale-applications - the merchant's queue of wholesale account applications (B2B Task 7).
 *
 * pending / approved / rejected / revoked. Approve picks an ACTIVE wholesale group; reject takes an optional note that the
 * applicant SEES; revoke takes the buyer out of every wholesale group and says what actually happened. The server decides
 * every transition atomically (a second admin gets 409). Plan gate: without `b2b.wholesale` the upgrade prompt shows.
 */

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { useT } from '@/i18n/useT';
import { AdminLayout } from '../../../../components/AdminLayout';
import { apiGet, apiPost } from '../../../../lib/api';
import { useRequireFeature } from '../../../../hooks/useRequireFeature';
import { notifyWholesalePendingChanged } from '../../../../hooks/useWholesalePending';
import {
  ApplicationDecisionModal,
  type DecisionKind,
} from './_components/ApplicationDecisionModal';
import { Button } from '@/components/ui/Button';

export type ApplicationStatus = 'pending' | 'approved' | 'rejected' | 'revoked';

export interface WholesaleApplicationRow {
  id: string;
  businessName: string;
  commercialRegNo: string | null;
  phone: string;
  notes: string | null;
  status: ApplicationStatus;
  decisionNote: string | null;
  createdAt: string;
  decidedAt: string | null;
  user: { email: string; firstName: string; lastName: string };
}

interface Group {
  id: string;
  name: string;
  nameAr: string | null;
  isWholesale: boolean;
  isActive: boolean;
}

const FILTERS: ApplicationStatus[] = ['pending', 'approved', 'rejected', 'revoked'];
const HOURS_OVERDUE = 48;

function hoursSince(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 3_600_000));
}

export default function WholesaleApplicationsPage() {
  const params = useParams();
  const storeId = params.id as string;
  const t = useT('wholesale.applications');

  const [status, setStatus] = useState<ApplicationStatus>('pending');
  const [rows, setRows] = useState<WholesaleApplicationRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deciding, setDeciding] = useState<{
    row: WholesaleApplicationRow;
    kind: DecisionKind;
  } | null>(null);
  const { gate } = useRequireFeature('b2b.wholesale');

  const base = `/api/v1/stores/${storeId}/wholesale-applications`;

  const load = useCallback(
    async (after?: string) => {
      setLoading(true);
      const qs = new URLSearchParams({ status, limit: '25' });
      if (after) qs.set('cursor', after);
      const { data, error: err } = await apiGet<{
        items: WholesaleApplicationRow[];
        nextCursor: string | null;
      }>(`${base}?${qs.toString()}`);
      if (err) setError(err.message || t('loadFailed'));
      else {
        setError(null);
        setRows(prev => (after ? [...prev, ...(data?.items ?? [])] : (data?.items ?? [])));
        setCursor(data?.nextCursor ?? null);
      }
      setLoading(false);
    },
    [base, status, t]
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void (async () => {
      const { data } = await apiGet<{ groups: Group[] }>(
        `/api/v1/stores/${storeId}/customer-groups`
      );
      setGroups((data?.groups ?? []).filter(g => g.isWholesale && g.isActive));
    })();
  }, [storeId]);

  const decide = async (input: { groupId?: string; note?: string }) => {
    if (!deciding) return;
    const { row, kind } = deciding;
    const body = kind === 'approve' ? { groupId: input.groupId } : { note: input.note || null };
    const { data, error: err } = await apiPost<{
      membership?: 'removed' | 'already_not_wholesale';
    }>(`${base}/${row.id}/${kind}`, body);
    if (err) {
      // 409 NOT_PENDING / NOT_APPROVED = another admin decided first: reload and say so.
      setError(
        err.code === 'NOT_PENDING' || err.code === 'NOT_APPROVED'
          ? t('alreadyDecided')
          : err.message
      );
      setDeciding(null);
      void load();
      notifyWholesalePendingChanged();
      return;
    }
    setDeciding(null);
    setError(null);
    setNotice(
      kind === 'approve'
        ? t('approvedNotice', { name: row.businessName })
        : kind === 'reject'
          ? t('rejectedNotice', { name: row.businessName })
          : data?.membership === 'already_not_wholesale'
            ? t('revokedAlreadyOut', { name: row.businessName })
            : t('revokedNotice', { name: row.businessName })
    );
    void load();
    notifyWholesalePendingChanged();
  };

  if (gate) return gate;

  return (
    <AdminLayout title={t('title')} subtitle={t('subtitle')} mode="store_admin" storeId={storeId}>
      <div className="mx-auto max-w-5xl px-4 py-6">
        <div role="tablist" aria-label={t('filterLabel')} className="mb-4 flex flex-wrap gap-2">
          {FILTERS.map(f => (
            <button
              key={f}
              type="button"
              role="tab"
              aria-selected={status === f}
              onClick={() => setStatus(f)}
              className={
                'min-h-11 rounded-md border px-4 text-sm md:min-h-9 ' +
                (status === f ? 'bg-primary text-primary-foreground' : 'hover:bg-muted')
              }
            >
              {t(`filter.${f}`)}
            </button>
          ))}
        </div>

        {error && (
          <div
            role="alert"
            className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive-ink"
          >
            {error}
          </div>
        )}
        {notice && (
          <div role="status" className="mb-4 rounded-md border bg-muted px-3 py-2 text-sm">
            {notice}
          </div>
        )}

        {loading && rows.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted-foreground">{t('loading')}</p>
        ) : rows.length === 0 ? (
          <div className="rounded-md border border-dashed py-12 text-center">
            <p className="text-sm font-medium">{t('emptyTitle')}</p>
            <p className="mt-1 text-sm text-muted-foreground">{t('emptyBody')}</p>
          </div>
        ) : (
          <ul className="space-y-3" data-testid="wholesale-application-list">
            {rows.map(row => {
              const waiting = row.status === 'pending' ? hoursSince(row.createdAt) : null;
              return (
                <li key={row.id} className="rounded-lg border bg-card p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-semibold">
                        <bdi>{row.businessName}</bdi>
                      </p>
                      <p className="text-sm text-muted-foreground">
                        <bdi>{`${row.user.firstName} ${row.user.lastName}`.trim()}</bdi> -{' '}
                        <bdi dir="ltr">{row.user.email}</bdi>
                      </p>
                      <p className="text-sm text-muted-foreground">
                        <bdi dir="ltr">{row.phone}</bdi>
                        {row.commercialRegNo ? (
                          <>
                            {' '}
                            - {t('regNo')} <bdi dir="ltr">{row.commercialRegNo}</bdi>
                          </>
                        ) : null}
                      </p>
                      {row.notes ? (
                        <p className="mt-2 text-sm">
                          <bdi>{row.notes}</bdi>
                        </p>
                      ) : null}
                      {row.decisionNote ? (
                        <p className="mt-2 text-sm text-muted-foreground">
                          {t('decisionNote')}: <bdi>{row.decisionNote}</bdi>
                        </p>
                      ) : null}
                      {waiting !== null ? (
                        <p
                          className={
                            'mt-2 text-xs font-medium ' +
                            (waiting >= HOURS_OVERDUE
                              ? 'text-warning-ink'
                              : 'text-muted-foreground')
                          }
                        >
                          {waiting >= HOURS_OVERDUE
                            ? t('waitingOverdue', { hours: waiting })
                            : t('waiting', { hours: waiting })}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {row.status === 'pending' ? (
                        <>
                          <Button
                            variant="default"
                            size="sm"
                            type="button"
                            onClick={() => setDeciding({ row, kind: 'approve' })}
                          >
                            {t('approve')}
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            type="button"
                            onClick={() => setDeciding({ row, kind: 'reject' })}
                          >
                            {t('reject')}
                          </Button>
                        </>
                      ) : null}
                      {row.status === 'approved' ? (
                        <Button
                          variant="outline"
                          size="sm"
                          className="text-destructive-ink"
                          type="button"
                          onClick={() => setDeciding({ row, kind: 'revoke' })}
                        >
                          {t('revoke')}
                        </Button>
                      ) : null}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {cursor ? (
          <div className="mt-4 text-center">
            <Button
              variant="outline"
              size="md"
              type="button"
              disabled={loading}
              onClick={() => void load(cursor)}
            >
              {t('loadMore')}
            </Button>
          </div>
        ) : null}

        {deciding ? (
          <ApplicationDecisionModal
            kind={deciding.kind}
            businessName={deciding.row.businessName}
            groups={groups}
            onCancel={() => setDeciding(null)}
            onConfirm={decide}
          />
        ) : null}
      </div>
    </AdminLayout>
  );
}
