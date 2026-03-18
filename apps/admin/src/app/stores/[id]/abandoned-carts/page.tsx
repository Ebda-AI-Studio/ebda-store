'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { useToast } from '@force/ui';
import { AdminLayout } from '../../../../components/AdminLayout';
import { apiGet, apiPut } from '../../../../lib/api';
import { useFeatures } from '../../../../hooks/useFeatures';

// ─── Types ────────────────────────────────────────────────────────────────────

interface AbandonedCartStats {
  totalAbandoned: number;
  totalRecovered: number;
  recoveryRate: number;
  recoveredRevenue: number;
}

interface AbandonedCartConfig {
  step1Enabled: boolean;
  step1DelayMinutes: number;
  step2Enabled: boolean;
  step2DelayMinutes: number;
  step3Enabled: boolean;
  step3DelayMinutes: number;
  autoCouponEnabled: boolean;
  couponDiscountPercent: number;
  couponMaxDiscount: number | null;
  couponExpiryHours: number;
}

interface AbandonedCartRecord {
  id: string;
  createdAt: string;
  status: string;
  customerEmail: string | null;
  customerPhone: string | null;
  cartTotal: number;
  cartItemCount: number;
  customer: {
    firstName: string;
    lastName: string;
    email: string;
    phone: string | null;
  } | null;
}

interface ListMeta {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

const DEFAULT_CONFIG: AbandonedCartConfig = {
  step1Enabled: true,
  step1DelayMinutes: 60,
  step2Enabled: true,
  step2DelayMinutes: 240,
  step3Enabled: true,
  step3DelayMinutes: 1440,
  autoCouponEnabled: true,
  couponDiscountPercent: 10,
  couponMaxDiscount: null,
  couponExpiryHours: 48,
};

// ─── Status Badge ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    pending: 'bg-yellow-100 text-yellow-700',
    step1_sent: 'bg-blue-100 text-blue-700',
    step2_sent: 'bg-blue-100 text-blue-700',
    step3_sent: 'bg-blue-100 text-blue-700',
    recovered: 'bg-green-100 text-green-700',
    expired: 'bg-gray-100 text-gray-600',
  };
  const labels: Record<string, string> = {
    pending: 'Pending',
    step1_sent: 'Step 1 Sent',
    step2_sent: 'Step 2 Sent',
    step3_sent: 'Step 3 Sent',
    recovered: 'Recovered',
    expired: 'Expired',
  };
  const cls = colors[status] || 'bg-gray-100 text-gray-600';
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${cls}`}>
      {labels[status] || status}
    </span>
  );
}

// ─── Toggle ───────────────────────────────────────────────────────────────────

function Toggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (val: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-orange-500 focus:ring-offset-2 disabled:opacity-50 ${
        checked ? 'bg-orange-500' : 'bg-gray-200'
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-6' : 'translate-x-1'
        }`}
      />
    </button>
  );
}

// ─── Stat Card ────────────────────────────────────────────────────────────────

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="bg-card rounded-xl border border-border p-5">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-bold text-foreground">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function AbandonedCartsPage() {
  const params = useParams();
  const storeId = params.id as string;
  const { isEnabled } = useFeatures();
  const { success: toastSuccess, error: showError } = useToast();

  const featureEnabled = isEnabled('abandoned_cart');

  // Stats
  const [stats, setStats] = useState<AbandonedCartStats | null>(null);

  // Config
  const [config, setConfig] = useState<AbandonedCartConfig>(DEFAULT_CONFIG);
  const [savingConfig, setSavingConfig] = useState(false);

  // Carts list
  const [records, setRecords] = useState<AbandonedCartRecord[]>([]);
  const [meta, setMeta] = useState<ListMeta>({ total: 0, page: 1, limit: 20, totalPages: 1 });
  const [statusFilter, setStatusFilter] = useState('all');
  const [page, setPage] = useState(1);

  // Loading
  const [loading, setLoading] = useState(true);

  // ─── Fetch ────────────────────────────────────────────────────────────────

  const fetchStats = useCallback(async () => {
    const { data } = await apiGet<{ stats: AbandonedCartStats }>(
      `/api/v1/stores/${storeId}/abandoned-carts/stats`
    );
    if (data?.stats) setStats(data.stats);
  }, [storeId]);

  const fetchConfig = useCallback(async () => {
    const { data } = await apiGet<{ config: AbandonedCartConfig }>(
      `/api/v1/stores/${storeId}/abandoned-carts/config`
    );
    if (data?.config) setConfig({ ...DEFAULT_CONFIG, ...data.config });
  }, [storeId]);

  const fetchCarts = useCallback(async () => {
    const qs = new URLSearchParams({ page: String(page), limit: '20' });
    if (statusFilter !== 'all') qs.set('status', statusFilter);
    const { data } = await apiGet<{ records: AbandonedCartRecord[]; meta: ListMeta }>(
      `/api/v1/stores/${storeId}/abandoned-carts?${qs}`
    );
    if (data) {
      setRecords(data.records || []);
      setMeta(data.meta || { total: 0, page: 1, limit: 20, totalPages: 1 });
    }
  }, [storeId, page, statusFilter]);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    await Promise.all([fetchStats(), fetchConfig(), fetchCarts()]);
    setLoading(false);
  }, [fetchStats, fetchConfig, fetchCarts]);

  useEffect(() => {
    fetchAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId]);

  useEffect(() => {
    if (!loading) fetchCarts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, statusFilter]);

  // ─── Save Config ─────────────────────────────────────────────────────────

  const handleSaveConfig = async () => {
    setSavingConfig(true);
    try {
      const { error } = await apiPut(`/api/v1/stores/${storeId}/abandoned-carts/config`, config);
      if (!error) {
        toastSuccess('Saved', 'Abandoned cart settings saved.');
      } else {
        showError('Error', error.message || 'Failed to save settings.');
      }
    } catch (err) {
      console.error('Failed to save config:', err);
      showError('Error', 'Failed to save settings. Please try again.');
    } finally {
      setSavingConfig(false);
    }
  };

  // ─── Helpers ──────────────────────────────────────────────────────────────

  function patchConfig(patch: Partial<AbandonedCartConfig>) {
    setConfig(prev => ({ ...prev, ...patch }));
  }

  const cartTotalKwd = (fils: number) => (fils / 1000).toFixed(3);

  const customerDisplay = (record: AbandonedCartRecord) => {
    if (record.customer) {
      const name = `${record.customer.firstName} ${record.customer.lastName}`.trim();
      return record.customer.email || record.customer.phone || name;
    }
    return record.customerEmail || record.customerPhone || '—';
  };

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <AdminLayout
      title="Abandoned Cart Recovery"
      subtitle="Recover lost sales with automated reminders"
    >
      {loading ? (
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-orange-500" />
        </div>
      ) : !featureEnabled ? (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <div className="w-16 h-16 bg-orange-100 rounded-full flex items-center justify-center mb-4">
            <svg
              className="w-8 h-8 text-orange-600"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z"
              />
            </svg>
          </div>
          <h2 className="text-xl font-semibold text-foreground mb-2">
            Abandoned Cart Recovery not enabled
          </h2>
          <p className="text-muted-foreground max-w-md">
            Enable the Abandoned Cart feature in your store features to start recovering lost sales.
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {/* ── Stats ─────────────────────────────────────────────────────── */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard label="Total Abandoned" value={stats?.totalAbandoned ?? 0} />
            <StatCard label="Recovered" value={stats?.totalRecovered ?? 0} />
            <StatCard label="Recovery Rate" value={`${stats?.recoveryRate ?? 0}%`} />
            <StatCard
              label="Revenue Recovered"
              value={`${cartTotalKwd(stats?.recoveredRevenue ?? 0)} KWD`}
            />
          </div>

          {/* ── Settings ──────────────────────────────────────────────────── */}
          <div className="bg-card rounded-xl border border-border p-6">
            <h2 className="text-lg font-semibold text-foreground mb-5">Recovery Settings</h2>

            <div className="space-y-6">
              {/* Step 1 */}
              <div className="border border-border rounded-lg p-4">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="font-medium text-foreground">Step 1 — First Reminder</h3>
                  <Toggle
                    checked={config.step1Enabled}
                    onChange={val => patchConfig({ step1Enabled: val })}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-sm text-muted-foreground">Send after</label>
                  <input
                    type="number"
                    min={1}
                    value={config.step1DelayMinutes}
                    onChange={e => patchConfig({ step1DelayMinutes: Number(e.target.value) })}
                    disabled={!config.step1Enabled}
                    className="w-20 px-3 py-1.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-orange-500 focus:border-orange-500 disabled:opacity-50"
                  />
                  <label className="text-sm text-muted-foreground">min</label>
                </div>
              </div>

              {/* Step 2 */}
              <div className="border border-border rounded-lg p-4">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="font-medium text-foreground">Step 2 — Follow-up Reminder</h3>
                  <Toggle
                    checked={config.step2Enabled}
                    onChange={val => patchConfig({ step2Enabled: val })}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-sm text-muted-foreground">Send after</label>
                  <input
                    type="number"
                    min={1}
                    value={config.step2DelayMinutes}
                    onChange={e => patchConfig({ step2DelayMinutes: Number(e.target.value) })}
                    disabled={!config.step2Enabled}
                    className="w-20 px-3 py-1.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-orange-500 focus:border-orange-500 disabled:opacity-50"
                  />
                  <label className="text-sm text-muted-foreground">min</label>
                </div>
              </div>

              {/* Step 3 */}
              <div className="border border-border rounded-lg p-4">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="font-medium text-foreground">Step 3 — Final Reminder</h3>
                  <Toggle
                    checked={config.step3Enabled}
                    onChange={val => patchConfig({ step3Enabled: val })}
                  />
                </div>
                <div className="flex items-center gap-2 mb-4">
                  <label className="text-sm text-muted-foreground">Send after</label>
                  <input
                    type="number"
                    min={1}
                    value={config.step3DelayMinutes}
                    onChange={e => patchConfig({ step3DelayMinutes: Number(e.target.value) })}
                    disabled={!config.step3Enabled}
                    className="w-20 px-3 py-1.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-orange-500 focus:border-orange-500 disabled:opacity-50"
                  />
                  <label className="text-sm text-muted-foreground">min</label>
                </div>

                {/* Auto-coupon */}
                <div className="pt-4 border-t border-border space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-foreground">Auto-coupon</span>
                    <Toggle
                      checked={config.autoCouponEnabled}
                      onChange={val => patchConfig({ autoCouponEnabled: val })}
                      disabled={!config.step3Enabled}
                    />
                  </div>
                  {config.autoCouponEnabled && config.step3Enabled && (
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-1">
                      <div>
                        <label className="block text-xs text-muted-foreground mb-1">Discount</label>
                        <div className="flex items-center gap-1">
                          <input
                            type="number"
                            min={1}
                            max={100}
                            value={config.couponDiscountPercent}
                            onChange={e =>
                              patchConfig({ couponDiscountPercent: Number(e.target.value) })
                            }
                            className="w-full px-3 py-1.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                          />
                          <span className="text-sm text-muted-foreground">%</span>
                        </div>
                      </div>
                      <div>
                        <label className="block text-xs text-muted-foreground mb-1">
                          Max Discount
                        </label>
                        <div className="flex items-center gap-1">
                          <input
                            type="number"
                            min={0}
                            step={0.001}
                            value={config.couponMaxDiscount ?? ''}
                            onChange={e =>
                              patchConfig({
                                couponMaxDiscount: e.target.value ? Number(e.target.value) : null,
                              })
                            }
                            placeholder="No limit"
                            className="w-full px-3 py-1.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                          />
                          <span className="text-sm text-muted-foreground">KWD</span>
                        </div>
                      </div>
                      <div>
                        <label className="block text-xs text-muted-foreground mb-1">Expiry</label>
                        <div className="flex items-center gap-1">
                          <input
                            type="number"
                            min={1}
                            value={config.couponExpiryHours}
                            onChange={e =>
                              patchConfig({ couponExpiryHours: Number(e.target.value) })
                            }
                            className="w-full px-3 py-1.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                          />
                          <span className="text-sm text-muted-foreground">hours</span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="mt-5 flex justify-end">
              <button
                onClick={handleSaveConfig}
                disabled={savingConfig}
                className="px-6 py-2 bg-orange-500 text-white rounded-lg hover:bg-orange-600 transition-colors disabled:opacity-50 flex items-center gap-2 text-sm font-medium"
              >
                {savingConfig && (
                  <span className="animate-spin inline-block h-4 w-4 border-2 border-white border-t-transparent rounded-full" />
                )}
                Save Settings
              </button>
            </div>
          </div>

          {/* ── Carts List ────────────────────────────────────────────────── */}
          <div className="bg-card rounded-xl border border-border overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-border">
              <div>
                <h2 className="text-lg font-semibold text-foreground">Abandoned Carts</h2>
                <p className="text-sm text-muted-foreground mt-0.5">
                  {meta.total} total record{meta.total !== 1 ? 's' : ''}
                </p>
              </div>
              <select
                value={statusFilter}
                onChange={e => {
                  setStatusFilter(e.target.value);
                  setPage(1);
                }}
                className="px-3 py-1.5 text-sm border border-border rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
              >
                <option value="all">All statuses</option>
                <option value="pending">Pending</option>
                <option value="step1_sent">Step 1 Sent</option>
                <option value="step2_sent">Step 2 Sent</option>
                <option value="step3_sent">Step 3 Sent</option>
                <option value="recovered">Recovered</option>
                <option value="expired">Expired</option>
              </select>
            </div>

            {records.length === 0 ? (
              <div className="p-12 text-center">
                <div className="w-12 h-12 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-3">
                  <svg
                    className="w-6 h-6 text-gray-400"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1.5}
                      d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z"
                    />
                  </svg>
                </div>
                <p className="text-muted-foreground text-sm">No abandoned carts found</p>
              </div>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="bg-muted border-b border-border">
                        <th className="text-left px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                          Customer
                        </th>
                        <th className="text-left px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                          Total
                        </th>
                        <th className="text-left px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                          Items
                        </th>
                        <th className="text-left px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                          Status
                        </th>
                        <th className="text-left px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                          Date
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {records.map(record => (
                        <tr key={record.id} className="hover:bg-muted">
                          <td className="px-6 py-3 text-sm text-foreground">
                            {customerDisplay(record)}
                          </td>
                          <td className="px-6 py-3 text-sm text-foreground whitespace-nowrap">
                            {cartTotalKwd(record.cartTotal)} KWD
                          </td>
                          <td className="px-6 py-3 text-sm text-muted-foreground">
                            {record.cartItemCount}
                          </td>
                          <td className="px-6 py-3">
                            <StatusBadge status={record.status} />
                          </td>
                          <td className="px-6 py-3 text-sm text-muted-foreground whitespace-nowrap">
                            {new Date(record.createdAt).toLocaleDateString()}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Pagination */}
                {meta.totalPages > 1 && (
                  <div className="flex items-center justify-between px-6 py-4 border-t border-border">
                    <p className="text-sm text-muted-foreground">
                      Page {meta.page} of {meta.totalPages} ({meta.total} total)
                    </p>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setPage(p => Math.max(1, p - 1))}
                        disabled={page === 1}
                        className="px-3 py-1.5 text-sm border border-border rounded-lg hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        Previous
                      </button>
                      <button
                        onClick={() => setPage(p => Math.min(meta.totalPages, p + 1))}
                        disabled={page === meta.totalPages}
                        className="px-3 py-1.5 text-sm border border-border rounded-lg hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        Next
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </AdminLayout>
  );
}
