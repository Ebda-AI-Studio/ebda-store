'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { useToast } from '@force/ui';
import { AdminLayout } from '../../../../components/AdminLayout';
import { apiGet, apiPut, apiPost, apiPatch } from '../../../../lib/api';

// ==========================================
// Interfaces
// ==========================================

interface AffiliateConfig {
  defaultCommissionRate: number;
  cookieDurationDays: number;
  minPayoutAmount: number;
  autoApprove: boolean;
  publicSignupEnabled: boolean;
}

interface AffiliateStats {
  totalAffiliates: number;
  activeAffiliates: number;
  totalReferrals: number;
  conversions: number;
  conversionRate: number;
  commissionPaid: number;
}

interface Affiliate {
  id: string;
  name: string;
  email: string;
  referralCode: string;
  status: string;
  totalEarned: number;
  pendingBalance: number;
  totalPaid: number;
  commissionRate: number | null;
  instagram: string | null;
  tiktok: string | null;
  notes: string | null;
  createdAt: string;
  _count: { referrals: number; payouts: number };
}

interface Meta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

// ==========================================
// Helpers
// ==========================================

const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-yellow-100 text-yellow-700',
  approved: 'bg-green-100 text-green-700',
  rejected: 'bg-red-100 text-red-700',
  suspended: 'bg-gray-100 text-gray-700',
};

function formatFils(fils: number): string {
  return `${(fils / 1000).toFixed(3)} KWD`;
}

const DEFAULT_CONFIG: AffiliateConfig = {
  defaultCommissionRate: 10,
  cookieDurationDays: 30,
  minPayoutAmount: 5000,
  autoApprove: false,
  publicSignupEnabled: true,
};

// ==========================================
// Page Component
// ==========================================

export default function AffiliatesPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const { success: toastSuccess, error: showError } = useToast();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [stats, setStats] = useState<AffiliateStats | null>(null);
  const [config, setConfig] = useState<AffiliateConfig>(DEFAULT_CONFIG);
  const [affiliates, setAffiliates] = useState<Affiliate[]>([]);
  const [meta, setMeta] = useState<Meta | null>(null);

  const [activeTab, setActiveTab] = useState<'affiliates' | 'config'>('affiliates');
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
    const { data } = await apiGet<{ data: { stats: AffiliateStats } }>(
      `/api/v1/stores/${storeId}/affiliates/stats`
    );
    if (data) setStats((data as any).stats ?? (data as any).data?.stats ?? null);
  }, [storeId]);

  const fetchConfig = useCallback(async () => {
    const { data } = await apiGet<{ data: { config: AffiliateConfig } }>(
      `/api/v1/stores/${storeId}/affiliates/config`
    );
    if (data) {
      const cfg = (data as any).config ?? (data as any).data?.config;
      if (cfg) setConfig({ ...DEFAULT_CONFIG, ...cfg });
    }
  }, [storeId]);

  const fetchAffiliates = useCallback(async () => {
    const qs = new URLSearchParams({ page: String(page), limit: '20' });
    if (statusFilter !== 'all') qs.set('status', statusFilter);

    const { data } = await apiGet<any>(`/api/v1/stores/${storeId}/affiliates?${qs}`);
    if (data) {
      const payload = (data as any).affiliates !== undefined ? data : ((data as any).data ?? data);
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
  }, [storeId]);

  useEffect(() => {
    if (!loading) fetchAffiliates();
  }, [statusFilter, page]);

  // ---- Config Save ----

  const handleSaveConfig = async () => {
    setSaving(true);
    try {
      const { error } = await apiPut(`/api/v1/stores/${storeId}/affiliates/config`, config);
      if (!error) {
        toastSuccess('Config Saved', 'Affiliate program settings updated.');
      } else {
        showError('Error', 'Failed to save config.');
      }
    } catch {
      showError('Error', 'Failed to save config.');
    } finally {
      setSaving(false);
    }
  };

  // ---- Status Actions ----

  const handleStatusAction = async (
    affiliate: Affiliate,
    action: 'approve' | 'reject' | 'suspend'
  ) => {
    setSaving(true);
    try {
      const { error } = await apiPatch(
        `/api/v1/stores/${storeId}/affiliates/${affiliate.id}/${action}`
      );
      if (!error) {
        toastSuccess('Updated', `Affiliate ${action}d successfully.`);
        fetchAffiliates();
        fetchStats();
      } else {
        showError('Error', `Failed to ${action} affiliate.`);
      }
    } catch {
      showError('Error', `Failed to ${action} affiliate.`);
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

  const handlePayout = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!payoutAffiliate) return;

    const amountFils = Math.round(parseFloat(payoutAmount) * 1000);
    if (!amountFils || amountFils <= 0) {
      showError('Invalid Amount', 'Enter a valid payout amount.');
      return;
    }

    setSaving(true);
    try {
      const { error } = await apiPost(
        `/api/v1/stores/${storeId}/affiliates/${payoutAffiliate.id}/payouts`,
        { amount: amountFils, method: payoutMethod, notes: payoutNotes || undefined }
      );
      if (!error) {
        toastSuccess('Payout Created', `Payout recorded for ${payoutAffiliate.name}.`);
        setShowPayoutModal(false);
        setPayoutAffiliate(null);
        fetchAffiliates();
        fetchStats();
      } else {
        showError('Error', 'Failed to create payout.');
      }
    } catch {
      showError('Error', 'Failed to create payout.');
    } finally {
      setSaving(false);
    }
  };

  // ==========================================
  // Render
  // ==========================================

  return (
    <AdminLayout title="Affiliate Program" subtitle="Manage influencer referrals and commissions">
      {loading ? (
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-orange-500" />
        </div>
      ) : (
        <>
          {/* Stats Cards */}
          {stats && (
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
              <div className="bg-card rounded-xl border border-border p-4">
                <p className="text-sm text-muted-foreground">Total Affiliates</p>
                <p className="text-2xl font-bold text-foreground">{stats.totalAffiliates}</p>
              </div>
              <div className="bg-card rounded-xl border border-border p-4">
                <p className="text-sm text-muted-foreground">Active Referrals</p>
                <p className="text-2xl font-bold text-green-600">{stats.totalReferrals}</p>
              </div>
              <div className="bg-card rounded-xl border border-border p-4">
                <p className="text-sm text-muted-foreground">Conversion Rate</p>
                <p className="text-2xl font-bold text-blue-600">{stats.conversionRate}%</p>
              </div>
              <div className="bg-card rounded-xl border border-border p-4">
                <p className="text-sm text-muted-foreground">Total Paid</p>
                <p className="text-2xl font-bold text-orange-600">
                  {formatFils(stats.commissionPaid)}
                </p>
              </div>
              <div className="bg-card rounded-xl border border-border p-4">
                <p className="text-sm text-muted-foreground">Conversions</p>
                <p className="text-2xl font-bold text-purple-600">{stats.conversions}</p>
              </div>
            </div>
          )}

          {/* Tabs */}
          <div className="flex gap-2 mb-6">
            <button
              onClick={() => setActiveTab('affiliates')}
              className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                activeTab === 'affiliates'
                  ? 'bg-orange-500 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              Affiliates
            </button>
            <button
              onClick={() => setActiveTab('config')}
              className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                activeTab === 'config'
                  ? 'bg-orange-500 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              Configuration
            </button>
          </div>

          {/* Affiliates Tab */}
          {activeTab === 'affiliates' && (
            <div className="bg-card rounded-xl border border-border overflow-hidden">
              {/* Status Filter */}
              <div className="flex flex-wrap gap-2 p-4 bg-muted border-b border-border">
                {['all', 'pending', 'approved', 'rejected', 'suspended'].map(s => (
                  <button
                    key={s}
                    onClick={() => {
                      setStatusFilter(s);
                      setPage(1);
                    }}
                    className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors capitalize ${
                      statusFilter === s
                        ? 'bg-orange-500 text-white'
                        : 'bg-card text-gray-700 hover:bg-gray-100 border border-border'
                    }`}
                  >
                    {s}
                  </button>
                ))}
              </div>

              {affiliates.length === 0 ? (
                <div className="p-12 text-center">
                  <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4">
                    <svg
                      className="w-8 h-8 text-gray-400"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={1.5}
                        d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
                      />
                    </svg>
                  </div>
                  <h3 className="text-lg font-semibold text-foreground mb-2">No Affiliates Yet</h3>
                  <p className="text-gray-500">
                    Affiliates will appear here when they sign up or are invited.
                  </p>
                </div>
              ) : (
                <>
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead>
                        <tr className="bg-muted border-b border-border">
                          <th className="text-left px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                            Name / Email
                          </th>
                          <th className="text-left px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                            Referral Code
                          </th>
                          <th className="text-left px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                            Status
                          </th>
                          <th className="text-left px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                            Total Earned
                          </th>
                          <th className="text-left px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                            Pending Balance
                          </th>
                          <th className="text-right px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                            Actions
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {affiliates.map(affiliate => (
                          <tr key={affiliate.id} className="hover:bg-muted">
                            <td className="px-6 py-4">
                              <div className="font-medium text-foreground">{affiliate.name}</div>
                              <div className="text-sm text-muted-foreground">{affiliate.email}</div>
                            </td>
                            <td className="px-6 py-4">
                              <code className="text-sm bg-muted px-2 py-1 rounded font-mono">
                                {affiliate.referralCode}
                              </code>
                            </td>
                            <td className="px-6 py-4">
                              <span
                                className={`px-2 py-1 rounded-full text-xs font-medium capitalize ${STATUS_COLORS[affiliate.status] ?? 'bg-gray-100 text-gray-700'}`}
                              >
                                {affiliate.status}
                              </span>
                            </td>
                            <td className="px-6 py-4 text-green-600 font-medium">
                              {formatFils(Number(affiliate.totalEarned))}
                            </td>
                            <td className="px-6 py-4 text-orange-600 font-medium">
                              {formatFils(Number(affiliate.pendingBalance))}
                            </td>
                            <td className="px-6 py-4">
                              <div className="flex items-center justify-end gap-2 flex-wrap">
                                {affiliate.status === 'pending' && (
                                  <>
                                    <button
                                      onClick={() => handleStatusAction(affiliate, 'approve')}
                                      disabled={saving}
                                      className="text-green-600 hover:text-green-700 text-sm font-medium disabled:opacity-50"
                                    >
                                      Approve
                                    </button>
                                    <button
                                      onClick={() => handleStatusAction(affiliate, 'reject')}
                                      disabled={saving}
                                      className="text-red-600 hover:text-red-700 text-sm font-medium disabled:opacity-50"
                                    >
                                      Reject
                                    </button>
                                  </>
                                )}
                                {affiliate.status === 'approved' && (
                                  <>
                                    <button
                                      onClick={() => openPayoutModal(affiliate)}
                                      disabled={saving || Number(affiliate.pendingBalance) <= 0}
                                      className="text-orange-500 hover:text-orange-600 text-sm font-medium disabled:opacity-30"
                                    >
                                      Payout
                                    </button>
                                    <button
                                      onClick={() => handleStatusAction(affiliate, 'suspend')}
                                      disabled={saving}
                                      className="text-gray-500 hover:text-gray-700 text-sm font-medium disabled:opacity-50"
                                    >
                                      Suspend
                                    </button>
                                  </>
                                )}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* Pagination */}
                  {meta && meta.totalPages > 1 && (
                    <div className="flex items-center justify-between px-6 py-4 border-t border-border bg-muted">
                      <p className="text-sm text-muted-foreground">
                        Page {meta.page} of {meta.totalPages} ({meta.total} total)
                      </p>
                      <div className="flex gap-2">
                        <button
                          onClick={() => setPage(p => Math.max(1, p - 1))}
                          disabled={page <= 1}
                          className="px-3 py-1 border border-border rounded text-sm disabled:opacity-50 hover:bg-card"
                        >
                          Previous
                        </button>
                        <button
                          onClick={() => setPage(p => Math.min(meta.totalPages, p + 1))}
                          disabled={page >= meta.totalPages}
                          className="px-3 py-1 border border-border rounded text-sm disabled:opacity-50 hover:bg-card"
                        >
                          Next
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* Config Tab */}
          {activeTab === 'config' && (
            <div className="space-y-6">
              <div className="bg-card rounded-xl border border-border p-6">
                <h2 className="text-lg font-semibold text-foreground mb-4">Commission & Payouts</h2>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                  <div>
                    <label className="block text-sm font-medium text-muted-foreground mb-2">
                      Default Commission Rate (%)
                    </label>
                    <input
                      type="number"
                      min="0"
                      max="100"
                      step="0.1"
                      value={config.defaultCommissionRate}
                      onChange={e =>
                        setConfig({
                          ...config,
                          defaultCommissionRate: parseFloat(e.target.value) || 0,
                        })
                      }
                      className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-muted-foreground mb-2">
                      Cookie Duration (days)
                    </label>
                    <input
                      type="number"
                      min="1"
                      max="365"
                      value={config.cookieDurationDays}
                      onChange={e =>
                        setConfig({ ...config, cookieDurationDays: parseInt(e.target.value) || 30 })
                      }
                      className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-muted-foreground mb-2">
                      Min Payout Amount (fils)
                    </label>
                    <input
                      type="number"
                      min="0"
                      value={config.minPayoutAmount}
                      onChange={e =>
                        setConfig({ ...config, minPayoutAmount: parseInt(e.target.value) || 0 })
                      }
                      className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                    />
                    <p className="text-xs text-muted-foreground mt-1">
                      {formatFils(config.minPayoutAmount)} KWD equivalent
                    </p>
                  </div>
                </div>
              </div>

              <div className="bg-card rounded-xl border border-border p-6">
                <h2 className="text-lg font-semibold text-foreground mb-4">Program Options</h2>
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-medium text-foreground">Auto-approve Applications</p>
                      <p className="text-sm text-muted-foreground">
                        Automatically approve new affiliate applications without manual review
                      </p>
                    </div>
                    <button
                      onClick={() => setConfig({ ...config, autoApprove: !config.autoApprove })}
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                        config.autoApprove ? 'bg-orange-500' : 'bg-gray-300'
                      }`}
                    >
                      <span
                        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                          config.autoApprove ? 'translate-x-6' : 'translate-x-1'
                        }`}
                      />
                    </button>
                  </div>
                  <div className="flex items-center justify-between border-t border-border pt-4">
                    <div>
                      <p className="font-medium text-foreground">Public Signup</p>
                      <p className="text-sm text-muted-foreground">
                        Allow influencers to sign up as affiliates through the public page
                      </p>
                    </div>
                    <button
                      onClick={() =>
                        setConfig({ ...config, publicSignupEnabled: !config.publicSignupEnabled })
                      }
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                        config.publicSignupEnabled ? 'bg-orange-500' : 'bg-gray-300'
                      }`}
                    >
                      <span
                        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                          config.publicSignupEnabled ? 'translate-x-6' : 'translate-x-1'
                        }`}
                      />
                    </button>
                  </div>
                </div>
              </div>

              <div className="flex justify-end">
                <button
                  onClick={handleSaveConfig}
                  disabled={saving}
                  className="px-6 py-2 bg-orange-500 text-white rounded-lg hover:bg-orange-600 transition-colors disabled:opacity-50 flex items-center gap-2"
                >
                  {saving && (
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" />
                  )}
                  Save Configuration
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {/* Payout Modal */}
      {showPayoutModal && payoutAffiliate && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-card rounded-xl shadow-xl w-full max-w-md">
            <div className="flex items-center justify-between p-6 border-b border-border">
              <h2 className="text-xl font-semibold text-foreground">Create Payout</h2>
              <button
                onClick={() => {
                  setShowPayoutModal(false);
                  setPayoutAffiliate(null);
                }}
                className="p-2 text-gray-400 hover:text-gray-600"
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

            <form onSubmit={handlePayout} className="p-6 space-y-4">
              <p className="text-sm text-muted-foreground">
                Paying out to <strong>{payoutAffiliate.name}</strong>. Available balance:{' '}
                <strong className="text-orange-600">
                  {formatFils(Number(payoutAffiliate.pendingBalance))}
                </strong>
              </p>

              <div>
                <label className="block text-sm font-medium text-muted-foreground mb-2">
                  Amount (KWD) <span className="text-red-500">*</span>
                </label>
                <input
                  type="number"
                  step="0.001"
                  min="0.001"
                  max={(Number(payoutAffiliate.pendingBalance) / 1000).toFixed(3)}
                  value={payoutAmount}
                  onChange={e => setPayoutAmount(e.target.value)}
                  placeholder="0.000"
                  className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-muted-foreground mb-2">
                  Method
                </label>
                <select
                  value={payoutMethod}
                  onChange={e => setPayoutMethod(e.target.value)}
                  className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                >
                  <option value="bank_transfer">Bank Transfer</option>
                  <option value="knet">KNET</option>
                  <option value="cash">Cash</option>
                  <option value="manual">Manual</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-muted-foreground mb-2">
                  Notes
                </label>
                <textarea
                  value={payoutNotes}
                  onChange={e => setPayoutNotes(e.target.value)}
                  placeholder="Optional notes for this payout"
                  rows={3}
                  className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500 resize-none"
                />
              </div>

              <div className="flex items-center justify-end gap-3 pt-4">
                <button
                  type="button"
                  onClick={() => {
                    setShowPayoutModal(false);
                    setPayoutAffiliate(null);
                  }}
                  className="px-4 py-2 text-gray-700 border border-border rounded-lg hover:bg-muted"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving || !payoutAmount}
                  className="px-4 py-2 bg-orange-500 text-white rounded-lg hover:bg-orange-600 disabled:opacity-50 flex items-center gap-2"
                >
                  {saving && (
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" />
                  )}
                  Confirm Payout
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </AdminLayout>
  );
}
