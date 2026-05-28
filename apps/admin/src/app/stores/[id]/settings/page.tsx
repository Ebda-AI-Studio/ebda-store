'use client';

import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useState, useEffect, useCallback } from 'react';
import { Button, Modal, useToast } from '@force/ui';
import { AdminLayout } from '../../../../components/AdminLayout';
import { WhatsAppIcon } from '../../../../components/icons/WhatsAppIcon';
import { useFeatures } from '../../../../hooks/useFeatures';
import { useAuth } from '../../../../lib/auth';
import { useT } from '@/i18n/useT';
import { apiGet, apiPatch, apiPut } from '../../../../lib/api';
import { PLAN_LABELS, STORE_PLANS, type StorePlan } from '@force/shared';

/**
 * Fetches the WBS integration status for the current store and surfaces
 * two status chips directly on the Settings page WhatsApp card:
 *   • Connected / Not connected
 *   • DM ordering: ON / OFF (only shown when connected)
 *
 * This makes the critical waCustomerOrderingEnabled toggle discoverable
 * without requiring a click-through to Settings → WhatsApp → Connection tab.
 */
function WhatsAppStatusInline({ storeId }: { storeId: string }) {
  const [status, setStatus] = useState<{
    connected: boolean;
    waOrdering: boolean;
  } | null>(null);

  useEffect(() => {
    if (!storeId) return;
    apiGet<{
      hasApiKey: boolean;
      wbsEnabled: boolean;
      waCustomerOrderingEnabled: boolean;
    }>(`/api/v1/stores/${storeId}/integrations/wbs`)
      .then(({ data }) => {
        if (data) {
          setStatus({
            connected: Boolean(data.hasApiKey && data.wbsEnabled),
            waOrdering: Boolean(data.waCustomerOrderingEnabled),
          });
        }
      })
      .catch(() => {
        // Silent — badge simply won't render on error
      });
  }, [storeId]);

  if (!status) return null;

  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      <span
        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${
          status.connected
            ? 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-400 dark:border-emerald-800'
            : 'bg-gray-100 text-gray-500 border-gray-200 dark:bg-gray-800 dark:text-gray-400 dark:border-gray-700'
        }`}
      >
        <span
          className={`h-1.5 w-1.5 rounded-full ${status.connected ? 'bg-emerald-500' : 'bg-gray-400'}`}
        />
        {status.connected ? 'Connected' : 'Not connected'}
      </span>
      {status.connected && (
        <span
          className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${
            status.waOrdering
              ? 'bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950/30 dark:text-orange-400 dark:border-orange-800'
              : 'bg-gray-100 text-gray-500 border-gray-200 dark:bg-gray-800 dark:text-gray-400 dark:border-gray-700'
          }`}
        >
          DM ordering: {status.waOrdering ? 'ON' : 'OFF'}
        </span>
      )}
    </div>
  );
}

interface SettingsCard {
  /** Translation key under `settings.cards` (e.g. `branding`). */
  key: string;
  href: string;
  icon: React.ReactNode;
  color: string;
  /** If set, this card is only shown when the named feature is enabled. */
  featureKey?: string;
}

interface StoreBasicInfo {
  id: string;
  name: string;
  plan: StorePlan;
  status: string;
}

export default function StoreSettingsPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const { isEnabled, isLoading } = useFeatures();
  const { user } = useAuth();
  const isSuperAdmin = user?.role === 'super_admin';
  const t = useT('settings');
  const tCards = useT('settings.cards');
  const { success: toastSuccess, error: toastError } = useToast();

  // Store info (plan + status) — needed for super_admin danger zone
  const [storeInfo, setStoreInfo] = useState<StoreBasicInfo | null>(null);

  // Suspend modal
  const [suspendModalOpen, setSuspendModalOpen] = useState(false);
  const [statusChanging, setStatusChanging] = useState(false);

  // Plan change
  const [planModalOpen, setPlanModalOpen] = useState(false);
  const [pendingPlan, setPendingPlan] = useState<StorePlan | null>(null);
  const [planChanging, setPlanChanging] = useState(false);

  const fetchStore = useCallback(async () => {
    if (!isSuperAdmin || !storeId) return;
    const { data } = await apiGet<{ store: StoreBasicInfo }>(`/api/v1/admin/stores/${storeId}`);
    if (data?.store) setStoreInfo(data.store);
  }, [isSuperAdmin, storeId]);

  useEffect(() => {
    fetchStore();
  }, [fetchStore]);

  const handleStatusChange = useCallback(async () => {
    if (!storeInfo) return;
    setStatusChanging(true);
    const newStatus = storeInfo.status === 'suspended' ? 'active' : 'suspended';
    const { error: apiErr } = await apiPatch(`/api/v1/stores/${storeId}/status`, {
      status: newStatus,
    });
    if (apiErr) {
      toastError('Status change failed', apiErr.message);
    } else {
      toastSuccess(
        newStatus === 'suspended' ? 'Store suspended' : 'Store reactivated',
        `${storeInfo.name} is now ${newStatus}.`
      );
      await fetchStore();
    }
    setStatusChanging(false);
    setSuspendModalOpen(false);
  }, [storeInfo, storeId, fetchStore, toastSuccess, toastError]);

  const handlePlanChange = useCallback(async () => {
    if (!pendingPlan) return;
    setPlanChanging(true);
    const { error: apiErr } = await apiPut(`/api/v1/admin/stores/${storeId}/plan`, {
      plan: pendingPlan,
    });
    if (apiErr) {
      toastError('Plan change failed', apiErr.message);
    } else {
      toastSuccess('Plan updated', `Store plan changed to ${PLAN_LABELS[pendingPlan].en}.`);
      await fetchStore();
    }
    setPlanChanging(false);
    setPlanModalOpen(false);
    setPendingPlan(null);
  }, [pendingPlan, storeId, fetchStore, toastSuccess, toastError]);

  const cards: SettingsCard[] = [
    {
      key: 'branding',
      href: `/stores/${storeId}/branding`,
      color: 'bg-primary/10 text-primary',
      icon: (
        <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01"
          />
        </svg>
      ),
    },
    {
      key: 'navigation',
      href: `/stores/${storeId}/navigation`,
      color: 'bg-sky-100 text-sky-600 dark:bg-sky-900/30 dark:text-sky-300',
      icon: (
        <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M4 6h16M4 12h16M4 18h16"
          />
        </svg>
      ),
    },
    /*
     * Hero / Categories / Announcement cards REMOVED 2026-05-21 (Ahmad
     * audit). Page Builder under Catalog now owns hero slides, category
     * tile config, and announcement bar visibility + content. The
     * standalone /hero, /categories, /announcement pages still work by
     * URL but are no longer discoverable from Settings — they're linked
     * from inside the matching Page Builder section card. SEO stays in
     * Settings since it's meta-tags + structured data, distinct from
     * page-builder's typography zones.
     */
    {
      key: 'seo',
      href: `/stores/${storeId}/seo`,
      color: 'bg-info/10 text-info dark:bg-info/30 dark:text-info',
      featureKey: 'seo',
      icon: (
        <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
          />
        </svg>
      ),
    },
    {
      key: 'domain',
      href: `/stores/${storeId}/domain`,
      color: 'bg-info/10 text-info dark:bg-info/30 dark:text-info',
      icon: (
        <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
      ),
    },
    {
      key: 'paymentSettings',
      href: `/stores/${storeId}/payment-settings`,
      color: 'bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-300',
      icon: (
        <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z"
          />
        </svg>
      ),
    },
    {
      key: 'shipping',
      href: `/stores/${storeId}/shipping`,
      color: 'bg-cyan-100 text-cyan-600 dark:bg-cyan-900/30 dark:text-cyan-300',
      icon: (
        <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
          />
        </svg>
      ),
    },
    {
      key: 'taxSettings',
      href: `/stores/${storeId}/tax`,
      color: 'bg-teal-100 text-teal-600 dark:bg-teal-900/30 dark:text-teal-300',
      featureKey: 'tax',
      icon: (
        <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z"
          />
        </svg>
      ),
    },
    {
      key: 'pwaSettings',
      href: `/stores/${storeId}/pwa`,
      color: 'bg-violet-100 text-violet-600',
      featureKey: 'pwa',
      icon: (
        <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z"
          />
        </svg>
      ),
    },
    {
      key: 'template',
      href: `/stores/${storeId}/template`,
      color: 'bg-primary/10 text-primary',
      icon: (
        <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z"
          />
        </svg>
      ),
    },
    {
      key: 'pages',
      href: `/stores/${storeId}/pages`,
      color: 'bg-slate-100 text-slate-600',
      icon: (
        <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z"
          />
        </svg>
      ),
    },
    {
      key: 'language',
      href: `/stores/${storeId}/language`,
      color: 'bg-sky-100 text-sky-600 dark:bg-sky-900/30 dark:text-sky-300',
      icon: (
        <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M11 21l5-10 5 10M12.751 5C11.783 10.77 8.07 15.61 3 18.129"
          />
        </svg>
      ),
    },
    /*
     * 5 cards REMOVED 2026-05-21 (Ahmad audit). Moved into the Marketing
     * hub as sibling tabs alongside AI Tools + WhatsApp:
     *   - marketingPixels  -> /stores/[id]/marketing-pixels
     *   - notifications    -> /stores/[id]/notifications
     *   - affiliates       -> /stores/[id]/affiliates
     *   - abandonedCarts   -> /stores/[id]/abandoned-carts
     *   - newsletter       -> /stores/[id]/newsletter
     *
     * shippingCarriers card also removed — it's a sub-concern of Shipping;
     * the /shipping page links to /shipping-carriers from inside.
     *
     * 2026-05-22 (Ahmad audit pt.2): WhatsApp surfaces moved BACK to
     * Settings — they're integration config + administrative actions,
     * not customer-engagement campaigns. Marketing hub keeps the
     * non-integration cards (notifications, newsletter, etc).
     */
    {
      key: 'whatsapp',
      href: `/stores/${storeId}/whatsapp`,
      color: 'bg-[#25D366]/10 text-[#25D366]',
      icon: <WhatsAppIcon className="h-6 w-6" />,
    },
    // 2026-05-28: waBotConfig card removed — Bot Mode + Service Menu +
    // Meta Catalog merged into the WhatsApp Integration tabset (above)
    // as the "Bot Config" tab to remove the page-bouncing overlap.
  ];

  return (
    <AdminLayout
      title={t('page.title')}
      subtitle={t('page.subtitle')}
      actions={
        <Link href={`/stores/${storeId}`}>
          <Button type="button" variant="outline">
            {t('page.backToStore')}
          </Button>
        </Link>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {isLoading
          ? Array.from({ length: 9 }).map((_, i) => (
              <div
                key={i}
                className="flex items-start gap-4 rounded-xl border bg-card p-6 shadow-sm animate-pulse"
              >
                <div className="h-12 w-12 flex-shrink-0 rounded-xl bg-muted" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 w-24 rounded bg-muted" />
                  <div className="h-3 w-full rounded bg-muted" />
                </div>
              </div>
            ))
          : cards
              .filter(card => !card.featureKey || isEnabled(card.featureKey))
              .map(card => (
                <Link
                  key={card.href}
                  href={card.href}
                  className="group flex items-start gap-4 rounded-xl border bg-card p-6 shadow-sm transition-all hover:border-primary hover:shadow-md"
                >
                  <div
                    className={`flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-xl ${card.color} transition-transform group-hover:scale-110`}
                  >
                    {card.icon}
                  </div>
                  <div className="min-w-0">
                    <h3 className="font-semibold text-foreground group-hover:text-primary transition-colors">
                      {tCards(`${card.key}.title`)}
                    </h3>
                    <p className="mt-1 text-sm text-muted-foreground leading-snug">
                      {tCards(`${card.key}.description`)}
                    </p>
                    {card.key === 'whatsapp' && <WhatsAppStatusInline storeId={storeId} />}
                  </div>
                </Link>
              ))}
      </div>

      {/* ── Super-admin: Plan info + Danger Zone ─────────────────────────── */}
      {isSuperAdmin && (
        <div className="mt-8 space-y-6">
          {/* Plan row */}
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 rounded-xl border bg-card p-5">
            <div>
              <p className="text-sm font-medium text-foreground">Store Plan</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {storeInfo
                  ? `${PLAN_LABELS[storeInfo.plan]?.en ?? storeInfo.plan} — ${PLAN_LABELS[storeInfo.plan]?.ar ?? ''}`
                  : 'Loading…'}
              </p>
            </div>
            {storeInfo && (
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center rounded-full bg-primary/10 text-primary px-3 py-1 text-sm font-medium">
                  {PLAN_LABELS[storeInfo.plan]?.en ?? storeInfo.plan}
                </span>
                <select
                  className="rounded-lg border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                  value=""
                  onChange={e => {
                    const val = e.target.value as StorePlan;
                    if (val && val !== storeInfo.plan) {
                      setPendingPlan(val);
                      setPlanModalOpen(true);
                    }
                  }}
                >
                  <option value="">Change plan…</option>
                  {STORE_PLANS.filter(p => p !== storeInfo.plan).map(p => (
                    <option key={p} value={p}>
                      {PLAN_LABELS[p].en} — {PLAN_LABELS[p].ar}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {/* Danger Zone */}
          <div>
            <h2 className="mb-3 font-semibold text-destructive">Danger Zone</h2>
            <div className="rounded-xl border-2 border-destructive/40 bg-destructive/5 p-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <p className="text-sm font-medium text-foreground">
                    {storeInfo?.status === 'suspended' ? 'Reactivate Store' : 'Suspend Store'}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {storeInfo?.status === 'suspended'
                      ? 'Allow customers to access and purchase from this store again.'
                      : 'Block customer access without deleting any data.'}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5" dir="rtl">
                    {storeInfo?.status === 'suspended'
                      ? 'السماح للعملاء بالوصول إلى المتجر والشراء منه مجدداً.'
                      : 'منع وصول العملاء إلى المتجر دون حذف أي بيانات.'}
                  </p>
                </div>
                <div className="shrink-0">
                  <Button
                    variant={storeInfo?.status === 'suspended' ? 'default' : 'destructive'}
                    onClick={() => setSuspendModalOpen(true)}
                    disabled={statusChanging || !storeInfo}
                  >
                    {storeInfo?.status === 'suspended' ? 'Reactivate Store' : 'Suspend Store'}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Modals ─────────────────────────────────────────────────────────── */}

      {/* Plan change confirm */}
      <Modal
        isOpen={planModalOpen}
        onClose={() => {
          setPlanModalOpen(false);
          setPendingPlan(null);
        }}
        title="Change Plan"
        size="sm"
      >
        <p className="text-sm text-muted-foreground">
          Changing plan to <strong>{pendingPlan ? PLAN_LABELS[pendingPlan].en : ''}</strong>.
          Feature overrides will be preserved. Continue?
        </p>
        <p className="text-sm text-muted-foreground mt-1" dir="rtl">
          تغيير الخطة إلى <strong>{pendingPlan ? PLAN_LABELS[pendingPlan].ar : ''}</strong>. ستُحفظ
          الإعدادات المخصصة. المتابعة؟
        </p>
        <div className="mt-6 flex justify-end gap-3">
          <Button
            variant="outline"
            onClick={() => {
              setPlanModalOpen(false);
              setPendingPlan(null);
            }}
            disabled={planChanging}
          >
            Cancel
          </Button>
          <Button
            variant="default"
            onClick={handlePlanChange}
            disabled={planChanging}
            isLoading={planChanging}
          >
            Confirm
          </Button>
        </div>
      </Modal>

      {/* Suspend / reactivate confirm */}
      <Modal
        isOpen={suspendModalOpen}
        onClose={() => setSuspendModalOpen(false)}
        title={storeInfo?.status === 'suspended' ? 'Reactivate Store' : 'Suspend Store'}
        size="sm"
      >
        <p className="text-sm text-muted-foreground">
          {storeInfo?.status === 'suspended'
            ? `Reactivate ${storeInfo?.name ?? 'this store'}? Customers will regain access immediately.`
            : `Suspend ${storeInfo?.name ?? 'this store'}? Customers will not be able to access or purchase from the store.`}
        </p>
        <div className="mt-6 flex justify-end gap-3">
          <Button
            variant="outline"
            onClick={() => setSuspendModalOpen(false)}
            disabled={statusChanging}
          >
            Cancel
          </Button>
          <Button
            variant={storeInfo?.status === 'suspended' ? 'default' : 'destructive'}
            onClick={handleStatusChange}
            disabled={statusChanging}
            isLoading={statusChanging}
          >
            {storeInfo?.status === 'suspended' ? 'Reactivate' : 'Suspend'}
          </Button>
        </div>
      </Modal>
    </AdminLayout>
  );
}
