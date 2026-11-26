'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useParams } from 'next/navigation';
import { useToast } from '@ebda/ui';
import { useT } from '@/i18n/useT';
import { AdminLayout } from '../../../../components/AdminLayout';
import { SearchInput } from '../../../../components/SearchInput';
import { apiGet, apiPut, apiPost, apiPatch } from '../../../../lib/api';
import { AffiliateStatsCards } from './_components/AffiliateStatsCards';
import { AffiliatesTable } from './_components/AffiliatesTable';
import { AffiliateCommissionForm } from './_components/AffiliateCommissionForm';
import { PayoutsHistory } from './_components/PayoutsHistory';
import {
  DEFAULT_CONFIG,
  type Affiliate,
  type AffiliateConfig,
  type AffiliateStats,
  type AffiliateStatusAction,
  type Meta,
} from './_components/types';
import { useRequireFeature } from '../../../../hooks/useRequireFeature';
import { useLatestRequest } from '../../../../hooks/useLatestRequest';

import { roundToMinor, REGION } from '@ebda/shared';
import { Button } from '@/components/ui/Button';
import { FIELD_CLASSES, TEXTAREA_CLASSES } from '@/components/ui/tokens';
type TabKey = 'affiliates' | 'config';

// Narrow type for tolerant unwrapping of legacy `{ data: { ... } }` responses.
interface StatsEnvelope {
  stats?: AffiliateStats;
  data?: { stats?: AffiliateStats };
}

interface ConfigEnvelope {
  config?: Partial<AffiliateConfig>;
  data?: { config?: Partial<AffiliateConfig> };
}

interface AffiliatesEnvelope {
  affiliates?: Affiliate[];
  meta?: Meta;
  data?: { affiliates?: Affiliate[]; meta?: Meta };
}

export default function AffiliatesPage() {
  const { gate } = useRequireFeature('affiliate');

  const params = useParams();
  const storeId = params?.id as string;
  const { success: toastSuccess, error: showError } = useToast();
  const tPage = useT('affiliates.page');
  const tCloseLabel = useT('common');
  const tTabs = useT('affiliates.tabs');
  const tToasts = useT('affiliates.toasts');

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [stats, setStats] = useState<AffiliateStats | null>(null);
  const [config, setConfig] = useState<AffiliateConfig>(DEFAULT_CONFIG);
  const [affiliates, setAffiliates] = useState<Affiliate[]>([]);
  const [meta, setMeta] = useState<Meta | null>(null);

  const [activeTab, setActiveTab] = useState<TabKey>('affiliates');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [page, setPage] = useState(1);
  // Bumped after a mutation: the fetch effect owns EVERY list request, so the refetch reads the
  // CURRENT status filter/page instead of the ones captured when the row's button rendered
  // (issues 2443, 2450).
  const [refreshKey, setRefreshKey] = useState(0);
  // Debounced search term — client-side filter over fetched affiliates by name or email.
  const [search, setSearch] = useState('');

  // Payout modal state
  const [showPayoutModal, setShowPayoutModal] = useState(false);
  const [payoutAffiliate, setPayoutAffiliate] = useState<Affiliate | null>(null);
  const [payoutAmount, setPayoutAmount] = useState('');
  const [payoutMethod, setPayoutMethod] = useState('bank_transfer');
  const [payoutNotes, setPayoutNotes] = useState('');

  // Invite affiliate modal state
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [inviteName, setInviteName] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [invitePhone, setInvitePhone] = useState('');
  const [inviteInstagram, setInviteInstagram] = useState('');
  const [inviteTiktok, setInviteTiktok] = useState('');
  const [inviteNotes, setInviteNotes] = useState('');
  const [inviting, setInviting] = useState(false);
  const inviteNameRef = useRef<HTMLInputElement>(null);

  // ---- Data Fetching ----

  const fetchStats = useCallback(async () => {
    const { data } = await apiGet<StatsEnvelope>(`/api/v1/stores/${storeId}/affiliates/stats`);
    if (data) setStats(data.stats ?? data.data?.stats ?? null);
  }, [storeId]);

  const fetchConfig = useCallback(async () => {
    const { data } = await apiGet<ConfigEnvelope>(`/api/v1/stores/${storeId}/affiliates/config`);
    if (data) {
      const cfg = data.config ?? data.data?.config;
      if (cfg) setConfig({ ...DEFAULT_CONFIG, ...cfg });
    }
  }, [storeId]);

  // Latest-request-wins: a slower response for the previous filter/page must not repaint its rows.
  const beginRequest = useLatestRequest();
  const fetchAffiliates = useCallback(async () => {
    const isLatest = beginRequest();
    const qs = new URLSearchParams({ page: String(page), limit: '20' });
    if (statusFilter !== 'all') qs.set('status', statusFilter);

    const { data } = await apiGet<AffiliatesEnvelope>(`/api/v1/stores/${storeId}/affiliates?${qs}`);
    if (!isLatest()) return;
    if (data) {
      const payload = data.affiliates !== undefined ? data : (data.data ?? data);
      setAffiliates(payload.affiliates ?? []);
      setMeta(payload.meta ?? null);
    }
  }, [storeId, page, statusFilter, beginRequest]);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    await Promise.all([fetchStats(), fetchConfig(), fetchAffiliates()]);
    setLoading(false);
  }, [fetchStats, fetchConfig, fetchAffiliates]);

  useEffect(() => {
    fetchAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId]);

  useEffect(() => {
    if (!loading) fetchAffiliates();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, page, refreshKey]);

  // ---- Config Save ----

  const handleSaveConfig = async () => {
    setSaving(true);
    try {
      const { error } = await apiPut(`/api/v1/stores/${storeId}/affiliates/config`, config);
      if (!error) {
        toastSuccess(tToasts('configSaved.title'), tToasts('configSaved.message'));
      } else {
        showError(tToasts('error.title'), tToasts('configError.message'));
      }
    } catch {
      showError(tToasts('error.title'), tToasts('configError.message'));
    } finally {
      setSaving(false);
    }
  };

  // ---- Status Actions ----

  const handleStatusAction = async (affiliate: Affiliate, action: AffiliateStatusAction) => {
    setSaving(true);
    try {
      const { error } = await apiPatch(
        `/api/v1/stores/${storeId}/affiliates/${affiliate.id}/${action}`
      );
      if (!error) {
        toastSuccess(tToasts('statusUpdated.title'), tToasts(`statusUpdated.${action}`));
        setRefreshKey(k => k + 1);
        fetchStats();
      } else {
        showError(tToasts('error.title'), tToasts(`statusError.${action}`));
      }
    } catch {
      showError(tToasts('error.title'), tToasts(`statusError.${action}`));
    } finally {
      setSaving(false);
    }
  };

  // ---- Payout ----

  const openPayoutModal = (affiliate: Affiliate) => {
    setPayoutAffiliate(affiliate);
    setPayoutAmount('');
    setPayoutMethod('bank_transfer');
    setPayoutNotes('');
    setShowPayoutModal(true);
  };

  const closePayoutModal = () => {
    setShowPayoutModal(false);
    setPayoutAffiliate(null);
  };

  const handlePayout = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!payoutAffiliate) return;

    const amountFils = roundToMinor(parseFloat(payoutAmount));
    if (!amountFils || amountFils <= 0) {
      showError(tToasts('invalidAmount.title'), tToasts('invalidAmount.message'));
      return;
    }

    setSaving(true);
    try {
      const { error } = await apiPost(
        `/api/v1/stores/${storeId}/affiliates/${payoutAffiliate.id}/payouts`,
        { amount: amountFils, method: payoutMethod, notes: payoutNotes || undefined }
      );
      if (!error) {
        toastSuccess(
          tToasts('payoutCreated.title'),
          tToasts('payoutCreated.message', { name: payoutAffiliate.name })
        );
        closePayoutModal();
        setRefreshKey(k => k + 1);
        fetchStats();
      } else {
        showError(tToasts('error.title'), tToasts('payoutError.message'));
      }
    } catch {
      showError(tToasts('error.title'), tToasts('payoutError.message'));
    } finally {
      setSaving(false);
    }
  };

  // ---- Invite Affiliate ----

  const openInviteModal = () => {
    setInviteName('');
    setInviteEmail('');
    setInvitePhone('');
    setInviteInstagram('');
    setInviteTiktok('');
    setInviteNotes('');
    setShowInviteModal(true);
    setTimeout(() => inviteNameRef.current?.focus(), 50);
  };

  const closeInviteModal = () => {
    setShowInviteModal(false);
  };

  const handleInviteAffiliate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inviteName.trim() || !inviteEmail.trim()) return;

    setInviting(true);
    try {
      const { error } = await apiPost(`/api/v1/stores/${storeId}/affiliates`, {
        name: inviteName.trim(),
        email: inviteEmail.trim(),
        phone: invitePhone.trim() || undefined,
        instagram: inviteInstagram.trim() || undefined,
        tiktok: inviteTiktok.trim() || undefined,
        notes: inviteNotes.trim() || undefined,
      });

      if (!error) {
        toastSuccess(tToasts('inviteCreated.title'), tToasts('inviteCreated.message'));
        closeInviteModal();
        setRefreshKey(k => k + 1);
        fetchStats();
      } else {
        showError(tToasts('error.title'), error.message || tToasts('inviteError.message'));
      }
    } catch {
      showError(tToasts('error.title'), tToasts('inviteError.message'));
    } finally {
      setInviting(false);
    }
  };

  // Client-side filter: match affiliate name or email (case-insensitive).
  const filteredAffiliates = useMemo(() => {
    if (!search.trim()) return affiliates;
    const q = search.toLowerCase();
    return affiliates.filter(
      a => a.name.toLowerCase().includes(q) || a.email.toLowerCase().includes(q)
    );
  }, [affiliates, search]);

  if (gate) return gate;

  return (
    <AdminLayout
      title={tPage('title')}
      subtitle={tPage('subtitle')}
      actions={
        <Button variant="default" size="md" type="button" onClick={openInviteModal}>
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          {tPage('inviteButton')}
        </Button>
      }
    >
      {loading ? (
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
        </div>
      ) : (
        <>
          {stats && <AffiliateStatsCards stats={stats} />}

          <div className="flex gap-2 mb-6">
            <Button
              variant={activeTab === 'affiliates' ? 'soft' : 'ghost'}
              size="md"
              type="button"
              onClick={() => setActiveTab('affiliates')}
            >
              {tTabs('affiliates')}
            </Button>
            <Button
              variant={activeTab === 'config' ? 'soft' : 'ghost'}
              size="md"
              type="button"
              onClick={() => setActiveTab('config')}
            >
              {tTabs('config')}
            </Button>
          </div>

          {activeTab === 'affiliates' && (
            <>
              <div className="mb-4">
                <SearchInput
                  value={search}
                  onSearch={val => {
                    setSearch(val);
                    setPage(1);
                  }}
                  placeholder={tPage('searchPlaceholder')}
                  className="w-full sm:w-72"
                />
              </div>
            </>
          )}

          {activeTab === 'affiliates' && (
            <AffiliatesTable
              storeId={storeId}
              affiliates={filteredAffiliates}
              meta={meta}
              statusFilter={statusFilter}
              page={page}
              saving={saving}
              onStatusFilterChange={s => {
                setStatusFilter(s);
                setPage(1);
              }}
              onPageChange={setPage}
              onStatusAction={handleStatusAction}
              onOpenPayout={openPayoutModal}
              onInvite={openInviteModal}
            />
          )}

          {activeTab === 'config' && (
            <AffiliateCommissionForm
              config={config}
              saving={saving}
              onConfigChange={setConfig}
              onSave={handleSaveConfig}
            />
          )}
        </>
      )}

      {showPayoutModal && payoutAffiliate && (
        <PayoutsHistory
          affiliate={payoutAffiliate}
          amount={payoutAmount}
          method={payoutMethod}
          notes={payoutNotes}
          saving={saving}
          onAmountChange={setPayoutAmount}
          onMethodChange={setPayoutMethod}
          onNotesChange={setPayoutNotes}
          onClose={closePayoutModal}
          onSubmit={handlePayout}
        />
      )}

      {showInviteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-lg rounded-md bg-background shadow-xl border border-border">
            <div className="flex items-center justify-between px-6 py-4 border-b border-border">
              <div>
                <h2 className="text-lg font-semibold">{tPage('inviteTitle')}</h2>
                <p className="text-sm text-muted-foreground">{tPage('inviteSubtitle')}</p>
              </div>
              <button
                type="button"
                onClick={closeInviteModal}
                aria-label={tCloseLabel('close')}
                className="text-muted-foreground hover:text-foreground"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>

            <form onSubmit={handleInviteAffiliate} className="px-6 py-5 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="col-span-2 sm:col-span-1">
                  <label className="block text-sm font-medium mb-1.5">
                    {tPage('inviteNameLabel')} *
                  </label>
                  <input
                    ref={inviteNameRef}
                    type="text"
                    value={inviteName}
                    onChange={e => setInviteName(e.target.value)}
                    required
                    maxLength={100}
                    placeholder={tPage('inviteNamePlaceholder')}
                    className={FIELD_CLASSES}
                  />
                </div>

                <div className="col-span-2 sm:col-span-1">
                  <label className="block text-sm font-medium mb-1.5">
                    {tPage('inviteEmailLabel')} *
                  </label>
                  <input
                    type="email"
                    value={inviteEmail}
                    onChange={e => setInviteEmail(e.target.value)}
                    required
                    placeholder={tPage('inviteEmailPlaceholder')}
                    className={FIELD_CLASSES}
                  />
                </div>

                <div className="col-span-2 sm:col-span-1">
                  <label className="block text-sm font-medium mb-1.5">
                    {tPage('invitePhoneLabel')}
                  </label>
                  <input
                    type="tel"
                    value={invitePhone}
                    onChange={e => setInvitePhone(e.target.value)}
                    maxLength={30}
                    placeholder={REGION.phone.placeholderIntl}
                    className={FIELD_CLASSES}
                  />
                </div>

                <div className="col-span-2 sm:col-span-1">
                  <label className="block text-sm font-medium mb-1.5">
                    {tPage('inviteInstagramLabel')}
                  </label>
                  <input
                    type="text"
                    value={inviteInstagram}
                    onChange={e => setInviteInstagram(e.target.value)}
                    maxLength={100}
                    placeholder="@username"
                    className={FIELD_CLASSES}
                  />
                </div>

                <div className="col-span-2 sm:col-span-1">
                  <label className="block text-sm font-medium mb-1.5">
                    {tPage('inviteTiktokLabel')}
                  </label>
                  <input
                    type="text"
                    value={inviteTiktok}
                    onChange={e => setInviteTiktok(e.target.value)}
                    maxLength={100}
                    placeholder="@username"
                    className={FIELD_CLASSES}
                  />
                </div>

                <div className="col-span-2">
                  <label className="block text-sm font-medium mb-1.5">
                    {tPage('inviteNotesLabel')}
                  </label>
                  <textarea
                    value={inviteNotes}
                    onChange={e => setInviteNotes(e.target.value)}
                    maxLength={1000}
                    rows={3}
                    placeholder={tPage('inviteNotesPlaceholder')}
                    className={`${TEXTAREA_CLASSES} resize-none`}
                  />
                </div>
              </div>

              <div className="flex items-center justify-end gap-3 pt-2 border-t border-border">
                <Button
                  variant="outline"
                  size="md"
                  type="button"
                  onClick={closeInviteModal}
                  disabled={inviting}
                >
                  {tPage('inviteCancel')}
                </Button>
                <Button
                  variant="default"
                  size="md"
                  type="submit"
                  disabled={inviting || !inviteName.trim() || !inviteEmail.trim()}
                >
                  {inviting ? tPage('inviting') : tPage('inviteSubmit')}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </AdminLayout>
  );
}
