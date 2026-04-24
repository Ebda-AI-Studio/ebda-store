'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Button } from '@force/ui';
import { AdminLayout } from '../components/AdminLayout';
import { apiGet } from '../lib/api';
import { useStore } from '../contexts/StoreContext';
import { useT } from '@/i18n/useT';
import { StatsGrid } from './_components/StatsGrid';
import { RecentStores } from './_components/RecentStores';
import { RecentOrders } from './_components/RecentOrders';
import { QuickActions } from './_components/QuickActions';
import type { PlatformStats, RecentStore, RecentOrder } from './_components/types';

export default function DashboardPage() {
  const t = useT('dashboard.super');
  const { selectedStoreId, stores: globalStores } = useStore();
  const storeName =
    selectedStoreId !== 'all' ? globalStores.find(s => s.id === selectedStoreId)?.name : null;
  const [stats, setStats] = useState<PlatformStats | null>(null);
  const [recentStores, setRecentStores] = useState<RecentStore[]>([]);
  const [recentOrders, setRecentOrders] = useState<RecentOrder[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    async function fetchData() {
      try {
        setIsLoading(true);
        setHasError(false);
        const params = new URLSearchParams();
        if (selectedStoreId !== 'all') params.append('storeId', selectedStoreId);
        const qs = params.toString() ? `?${params}` : '';
        const { data } = await apiGet<{
          stats: PlatformStats;
          recentStores: RecentStore[];
          recentOrders: RecentOrder[];
        }>(`/api/v1/admin/dashboard${qs}`);
        if (data) {
          setStats(data.stats);
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
  }, [selectedStoreId]);

  if (hasError) {
    return (
      <AdminLayout title={t('title')} subtitle={t('subtitleAll')}>
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <p className="text-muted-foreground mb-4">{t('loadFailed')}</p>
          <button
            onClick={() => {
              setHasError(false);
              setIsLoading(true);
            }}
            className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors cursor-pointer"
          >
            {t('retry')}
          </button>
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout
      title={t('title')}
      subtitle={storeName ? t('subtitleStore', { store: storeName }) : t('subtitleAll')}
      actions={
        <Link href="/stores/new">
          <Button size="sm" className="gap-2 shadow-lg shadow-primary/25">
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
      }
    >
      {/* Stats Grid */}
      <StatsGrid stats={stats} isLoading={isLoading} />

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
