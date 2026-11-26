'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { isStoreScopedRole } from '@/lib/store-scoped-role';
import { AdminLayout } from '../components/AdminLayout';
import { apiGet } from '../lib/api';
import { useStore } from '../contexts/StoreContext';
import { useAuth } from '../lib/auth';
import { useT } from '@/i18n/useT';
import { StatsGrid } from './_components/StatsGrid';
import { RecentStores } from './_components/RecentStores';
import { RecentOrders } from './_components/RecentOrders';
import { QuickActions } from './_components/QuickActions';
import { ReferralCard } from './_components/ReferralCard';
import type { PlatformStats, RecentStore, RecentOrder } from './_components/types';

export default function DashboardPage() {
  const t = useT('dashboard.super');
  const router = useRouter();
  const { user } = useAuth();
  const { selectedStoreId, stores: globalStores, isLoading: storesLoading } = useStore();
  const storeName =
    selectedStoreId !== 'all' ? globalStores.find(s => s.id === selectedStoreId)?.name : null;
  const [stats, setStats] = useState<PlatformStats | null>(null);
  const [recentStores, setRecentStores] = useState<RecentStore[]>([]);
  const [recentOrders, setRecentOrders] = useState<RecentOrder[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);

  // Store admins shouldn't see the platform-wide super-admin dashboard.
  // As soon as their store list resolves, redirect them to their store
  // dashboard. The redirect is one-shot — once we leave this page the
  // store-scoped admin shell takes over.
  useEffect(() => {
    if (!isStoreScopedRole(user?.role)) return;
    // A self-serve merchant who has not created a store yet lands in the
    // onboarding stepper, not on an empty platform dashboard.
    if (!storesLoading && globalStores.length === 0) {
      router.replace('/onboarding');
      return;
    }
    if (globalStores.length === 0) return;
    const target = globalStores[0];
    if (target?.id) router.replace(`/stores/${target.id}`);
  }, [user?.role, globalStores, storesLoading, router]);

  useEffect(() => {
    // Don't fetch the platform dashboard while we're about to redirect
    // a store admin to their store dashboard — the api would 200 with
    // a store-scoped slice, but rendering it here is wasted work.
    if (isStoreScopedRole(user?.role)) return;

    async function fetchData() {
      try {
        setIsLoading(true);
        setHasError(false);
        const params = new URLSearchParams();
        if (selectedStoreId !== 'all') params.append('storeId', selectedStoreId);
        const qs = params.toString() ? `?${params}` : '';
        const { data } = await apiGet<{
          stats: PlatformStats;
          referrals?: PlatformStats['referrals'];
          recentStores: RecentStore[];
          recentOrders: RecentOrder[];
        }>(`/api/v1/admin/dashboard${qs}`);
        if (data) {
          setStats({ ...data.stats, referrals: data.referrals ?? null });
          setRecentStores(data.recentStores || []);
          setRecentOrders(data.recentOrders || []);
        }
      } catch (error) {
        console.error('Failed to fetch dashboard data:', error);
        setHasError(true);
      } finally {
        setIsLoading(false);
      }
    }
    fetchData();
  }, [selectedStoreId, user?.role]);

  if (hasError) {
    return (
      <AdminLayout title={t('title')} subtitle={t('subtitleAll')}>
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <p className="text-muted-foreground mb-4">{t('loadFailed')}</p>
          <Button
            type="button"
            onClick={() => {
              setHasError(false);
              setIsLoading(true);
            }}
          >
            {t('retry')}
          </Button>
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout
      title={t('title')}
      subtitle={storeName ? t('subtitleStore', { store: storeName }) : t('subtitleAll')}
      actions={
        // Provisioning new stores is a super-admin operation only.
        user?.role === 'super_admin' ? (
          <Link href="/stores/new">
            <Button size="sm" className="gap-2 shadow-md shadow-sm">
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 4v16m8-8H4"
                />
              </svg>
              {t('newStore')}
            </Button>
          </Link>
        ) : null
      }
    >
      {/* Stats Grid */}
      <StatsGrid stats={stats} isLoading={isLoading} />

      <ReferralCard referrals={stats?.referrals} />

      {/* Recent Activity Section */}
      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <RecentStores stores={recentStores} isLoading={isLoading} />
        <RecentOrders orders={recentOrders} isLoading={isLoading} storeName={storeName ?? null} />
      </div>

      {/* Quick Actions */}
      <QuickActions />
    </AdminLayout>
  );
}
