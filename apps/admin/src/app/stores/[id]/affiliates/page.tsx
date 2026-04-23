'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { useToast } from '@force/ui';
import { useT } from '@/i18n/useT';
import { AdminLayout } from '../../../../components/AdminLayout';
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
  const params = useParams();
  const storeId = params?.id as string;
  const { success: toastSuccess, error: showError } = useToast();
  const tPage = useT('affiliates.page');
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

  // Payout modal state
  const [showPayoutModal, setShowPayoutModal] = useState(false);
  const [payoutAffiliate, setPayoutAffiliate] = useState<Affiliate | null>(null);
  const [payoutAmount, setPayoutAmount] = useState('');
  const [payoutMethod, setPayoutMethod] = useState('bank_transfer');
  const [payoutNotes, setPayoutNotes] = useState('');

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

  const fetchAffiliates = useCallback(async () => {
    const qs = new URLSearchParams({ page: String(page), limit: '20' });
    if (statusFilter !== 'all') qs.set('status', statusFilter);

    const { data } = await apiGet<AffiliatesEnvelope>(`/api/v1/stores/${storeId}/affiliates?${qs}`);
    if (data) {
      const payload = data.affiliates !== undefined ? data : (data.data ?? data);
      setAffiliates(payload.affiliates ?? []);
      setMeta(payload.meta ?? null);
    }
  }, [storeId, page, statusFilter]);

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
  }, [statusFilter, page]);

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
        fetchAffiliates();
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

    const amountFils = Math.round(parseFloat(payoutAmount) * 1000);
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
        fetchAffiliates();
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

  return (
    <AdminLayout title={tPage('title')} subtitle={tPage('subtitle')}>
      {loading ? (
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
        </div>
      ) : (
        <>
          {stats && <AffiliateStatsCards stats={stats} />}

          <div className="flex gap-2 mb-6">
            <button
              onClick={() => setActiveTab('affiliates')}
              className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                activeTab === 'affiliates'
                  ? 'bg-primary text-white'
                  : 'bg-muted text-foreground hover:bg-muted/80'
              }`}
            >
              {tTabs('affiliates')}
            </button>
            <button
              onClick={() => setActiveTab('config')}
              className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                activeTab === 'config'
                  ? 'bg-primary text-white'
                  : 'bg-muted text-foreground hover:bg-muted/80'
              }`}
            >
              {tTabs('config')}
            </button>
          </div>

          {activeTab === 'affiliates' && (
            <AffiliatesTable
              affiliates={affiliates}
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
    </AdminLayout>
  );
}
