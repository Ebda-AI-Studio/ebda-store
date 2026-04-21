'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { AdminLayout } from '../../../../components/AdminLayout';
import { apiGet } from '../../../../lib/api';

interface DashboardStats {
  totalRevenue: number;
  totalOrders: number;
  totalCustomers: number;
  totalProducts: number;
  averageOrderValue: number;
  revenueChange: number;
  ordersChange: number;
  customersChange: number;
}

interface SalesData {
  date: string;
  revenue: number;
  orders: number;
}

interface TopProduct {
  id: string;
  name: string;
  slug: string;
  revenue: number;
  quantity: number;
  image?: string;
}

interface RecentOrder {
  id: string;
  orderNumber: string;
  total: number;
  status: string;
  createdAt: string;
  customer?: {
    firstName: string;
    lastName: string;
    email: string;
  };
}

interface LowStockProduct {
  id: string;
  name: string;
  sku: string;
  inventory: number;
  images?: { url: string }[];
}

type Period = 'week' | 'month' | 'year';

function formatCurrency(amount: number) {
  return new Intl.NumberFormat('en-KW', {
    style: 'currency',
    currency: 'KWD',
    minimumFractionDigits: 3,
  }).format(amount / 1000);
}

function formatNumber(num: number) {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1) + 'M';
  }
  if (num >= 1000) {
    return (num / 1000).toFixed(1) + 'K';
  }
  return num.toString();
}

function formatDate(date: string) {
  return new Date(date).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

// Simple bar chart component
function SimpleBarChart({
  data,
  dataKey,
  label,
}: {
  data: SalesData[];
  dataKey: 'revenue' | 'orders';
  label: string;
}) {
  if (!data.length) return null;

  const maxValue = Math.max(...data.map(d => d[dataKey]));

  return (
    <div className="space-y-2">
      <div className="flex justify-between text-xs text-muted-foreground mb-4">
        <span>{label}</span>
        <span>Max: {dataKey === 'revenue' ? formatCurrency(maxValue) : maxValue}</span>
      </div>
      <div className="flex items-end gap-1 h-40">
        {data.map((item, i) => {
          const height = maxValue > 0 ? (item[dataKey] / maxValue) * 100 : 0;
          return (
            <div key={i} className="flex-1 flex flex-col items-center gap-1 group">
              <div
                className="w-full bg-primary rounded-t transition-all group-hover:bg-primary/90"
                style={{ height: `${Math.max(height, 2)}%` }}
                title={`${formatDate(item.date)}: ${dataKey === 'revenue' ? formatCurrency(item[dataKey]) : item[dataKey]}`}
              />
              {i % Math.ceil(data.length / 7) === 0 && (
                <span className="text-[10px] text-muted-foreground -rotate-45 origin-top-left whitespace-nowrap">
                  {formatDate(item.date)}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Stat card skeleton
function StatCardSkeleton() {
  return (
    <div className="force-stat-card">
      <div className="flex items-start justify-between">
        <div className="flex-1 space-y-3">
          <div className="h-3 w-24 force-skeleton" />
          <div className="h-8 w-32 force-skeleton" />
          <div className="h-3 w-16 force-skeleton" />
        </div>
        <div className="h-12 w-12 rounded-2xl force-skeleton" />
      </div>
    </div>
  );
}

// Stat card component
function StatCard({
  title,
  value,
  change,
  icon,
  iconBg = 'bg-primary',
  format = 'number',
}: {
  title: string;
  value: number;
  change?: number;
  icon: React.ReactNode;
  iconBg?: string;
  format?: 'number' | 'currency' | 'percentage';
}) {
  const displayValue =
    format === 'currency'
      ? formatCurrency(value)
      : format === 'percentage'
        ? `${value.toFixed(1)}%`
        : formatNumber(value);

  const isPositive = change !== undefined && change >= 0;

  return (
    <div className="force-stat-card group">
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <p className="text-sm font-medium text-muted-foreground">{title}</p>
          <p className="mt-2 text-3xl font-bold tracking-tight text-foreground">{displayValue}</p>
          {change !== undefined && (
            <div className="mt-2 flex items-center gap-1">
              <span
                className={`inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-xs font-semibold ${
                  isPositive
                    ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300'
                    : 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300'
                }`}
              >
                <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2.5}
                    d={isPositive ? 'M5 10l7-7m0 0l7 7m-7-7v18' : 'M19 14l-7 7m0 0l-7-7m7 7V3'}
                  />
                </svg>
                {Math.abs(change).toFixed(1)}%
              </span>
              <span className="text-xs text-muted-foreground">vs last period</span>
            </div>
          )}
        </div>
        <div
          className={`flex h-12 w-12 items-center justify-center rounded-2xl ${iconBg} text-white shadow-lg transition-transform duration-200 group-hover:scale-110`}
        >
          {icon}
        </div>
      </div>
    </div>
  );
}

export default function AnalyticsPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const [period, setPeriod] = useState<Period>('month');
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [salesData, setSalesData] = useState<SalesData[]>([]);
  const [topProducts, setTopProducts] = useState<TopProduct[]>([]);
  const [recentOrders, setRecentOrders] = useState<RecentOrder[]>([]);
  const [lowStockProducts, setLowStockProducts] = useState<LowStockProduct[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [chartType, setChartType] = useState<'revenue' | 'orders'>('revenue');

  const fetchAnalytics = useCallback(async () => {
    if (!storeId) return;
    setIsLoading(true);

    try {
      const basePath = `/api/v1/stores/${storeId}/analytics`;

      const [dashboardResult, salesResult, productsResult, ordersResult, stockResult] =
        await Promise.all([
          apiGet<{ stats: DashboardStats }>(`${basePath}/dashboard`),
          apiGet<{ sales: SalesData[] }>(`${basePath}/sales?period=${period}`),
          apiGet<{ products: TopProduct[] }>(`${basePath}/top-products?limit=5`),
          apiGet<{ orders: RecentOrder[] }>(`${basePath}/recent-orders?limit=5`),
          apiGet<{ products: LowStockProduct[] }>(`${basePath}/low-stock?threshold=10`),
        ]);

      if (dashboardResult.data) {
        setStats(dashboardResult.data.stats);
      }

      if (salesResult.data) {
        setSalesData(salesResult.data.sales);
      }

      if (productsResult.data) {
        setTopProducts(productsResult.data.products);
      }

      if (ordersResult.data) {
        setRecentOrders(ordersResult.data.orders);
      }

      if (stockResult.data) {
        setLowStockProducts(stockResult.data.products);
      }
    } catch (error) {
      console.error('Failed to fetch analytics:', error);
    } finally {
      setIsLoading(false);
    }
  }, [storeId, period]);

  useEffect(() => {
    fetchAnalytics();
  }, [fetchAnalytics]);

  const statusColors: Record<string, string> = {
    pending: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300',
    confirmed: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
    processing: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300',
    shipped: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300',
    delivered: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
    cancelled: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
    refunded: 'bg-muted text-foreground',
  };

  return (
    <AdminLayout title="Analytics" subtitle="Store performance and insights">
      {/* Period Selector */}
      <div className="mb-6 flex items-center gap-1 rounded-xl bg-muted p-1 w-fit">
        {(['week', 'month', 'year'] as Period[]).map(p => (
          <button
            key={p}
            onClick={() => setPeriod(p)}
            className={`cursor-pointer rounded-lg px-4 py-2 text-sm font-medium transition-all duration-200 ${
              period === p
                ? 'bg-card text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {p === 'week' ? 'Last 7 Days' : p === 'month' ? 'This Month' : 'This Year'}
          </button>
        ))}
      </div>

      {isLoading ? (
        <>
          {/* Skeleton Stats Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
            {Array.from({ length: 4 }).map((_, i) => (
              <StatCardSkeleton key={i} />
            ))}
          </div>
          {/* Skeleton Chart */}
          <div className="bg-card rounded-xl border p-6 shadow-sm mb-8">
            <div className="h-6 w-40 force-skeleton mb-6" />
            <div className="h-40 force-skeleton rounded-lg" />
          </div>
          {/* Skeleton 3-col */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="bg-card rounded-xl border p-6 shadow-sm space-y-4">
                <div className="h-5 w-32 force-skeleton" />
                {Array.from({ length: 4 }).map((_, j) => (
                  <div key={j} className="flex items-center gap-3">
                    <div className="h-10 w-10 rounded-lg force-skeleton" />
                    <div className="flex-1 space-y-2">
                      <div className="h-3 w-28 force-skeleton" />
                      <div className="h-3 w-20 force-skeleton" />
                    </div>
                    <div className="h-5 w-16 force-skeleton" />
                  </div>
                ))}
              </div>
            ))}
          </div>
        </>
      ) : (
        <>
          {/* Stats Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8 stagger-animation">
            <StatCard
              title="Total Revenue"
              value={stats?.totalRevenue || 0}
              change={stats?.revenueChange}
              format="currency"
              iconBg="bg-primary"
              icon={
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
              }
            />
            <StatCard
              title="Total Orders"
              value={stats?.totalOrders || 0}
              change={stats?.ordersChange}
              iconBg="bg-violet-500"
              icon={
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z"
                  />
                </svg>
              }
            />
            <StatCard
              title="Total Customers"
              value={stats?.totalCustomers || 0}
              change={stats?.customersChange}
              iconBg="bg-emerald-500"
              icon={
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
                  />
                </svg>
              }
            />
            <StatCard
              title="Avg Order Value"
              value={stats?.averageOrderValue || 0}
              format="currency"
              iconBg="bg-blue-500"
              icon={
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z"
                  />
                </svg>
              }
            />
          </div>

          {/* Sales Chart */}
          <div className="bg-card rounded-xl border p-6 shadow-sm mb-8">
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 className="text-lg font-semibold text-foreground">Sales Overview</h2>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {period === 'week'
                    ? 'Last 7 days'
                    : period === 'month'
                      ? 'This month'
                      : 'This year'}
                </p>
              </div>
              <div className="flex items-center gap-1 rounded-lg bg-muted p-1">
                <button
                  onClick={() => setChartType('revenue')}
                  className={`cursor-pointer rounded-md px-3 py-1 text-xs font-medium transition-all duration-200 ${
                    chartType === 'revenue'
                      ? 'bg-card text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  Revenue
                </button>
                <button
                  onClick={() => setChartType('orders')}
                  className={`cursor-pointer rounded-md px-3 py-1 text-xs font-medium transition-all duration-200 ${
                    chartType === 'orders'
                      ? 'bg-card text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  Orders
                </button>
              </div>
            </div>
            <SimpleBarChart
              data={salesData}
              dataKey={chartType}
              label={chartType === 'revenue' ? 'Revenue' : 'Number of Orders'}
            />
          </div>

          {/* Three Column Layout */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Top Products */}
            <div className="bg-card rounded-xl border p-6 shadow-sm">
              <h2 className="text-lg font-semibold text-foreground mb-4">Top Products</h2>
              {topProducts.length === 0 ? (
                <p className="text-muted-foreground text-sm">No sales data yet</p>
              ) : (
                <div className="space-y-4">
                  {topProducts.map((product, i) => (
                    <div key={product.id} className="flex items-center gap-3">
                      <span className="text-sm font-medium text-muted-foreground w-4">{i + 1}</span>
                      {product.image ? (
                        <img
                          src={product.image}
                          alt={product.name}
                          className="w-10 h-10 rounded object-cover"
                        />
                      ) : (
                        <div className="w-10 h-10 rounded bg-muted flex items-center justify-center">
                          <svg
                            className="w-5 h-5 text-muted-foreground"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
                            />
                          </svg>
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-foreground truncate">
                          {product.name}
                        </p>
                        <p className="text-xs text-muted-foreground">{product.quantity} sold</p>
                      </div>
                      <span className="text-sm font-semibold text-foreground">
                        {formatCurrency(product.revenue)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Recent Orders */}
            <div className="bg-card rounded-xl border p-6 shadow-sm">
              <h2 className="text-lg font-semibold text-foreground mb-4">Recent Orders</h2>
              {recentOrders.length === 0 ? (
                <p className="text-muted-foreground text-sm">No orders yet</p>
              ) : (
                <div className="space-y-4">
                  {recentOrders.map(order => (
                    <div key={order.id} className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-medium text-foreground">
                          {order.customer
                            ? `${order.customer.firstName} ${order.customer.lastName}`
                            : 'Guest'}
                        </p>
                        <p className="text-xs text-muted-foreground">#{order.orderNumber}</p>
                      </div>
                      <div className="text-right">
                        <p className="text-sm font-semibold text-foreground">
                          {formatCurrency(order.total)}
                        </p>
                        <span
                          className={`inline-block px-2 py-0.5 text-xs rounded-full ${
                            statusColors[order.status] || 'bg-muted text-foreground'
                          }`}
                        >
                          {order.status}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Low Stock Alerts */}
            <div className="bg-card rounded-xl border p-6 shadow-sm">
              <h2 className="text-lg font-semibold text-foreground mb-4">Low Stock Alerts</h2>
              {lowStockProducts.length === 0 ? (
                <div className="text-center py-4">
                  <svg
                    className="w-12 h-12 text-green-200 mx-auto mb-2"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                    />
                  </svg>
                  <p className="text-muted-foreground text-sm">All products are well stocked</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {lowStockProducts.slice(0, 5).map(product => (
                    <div key={product.id} className="flex items-center gap-3">
                      {product.images?.[0]?.url ? (
                        <img
                          src={product.images[0].url}
                          alt={product.name}
                          className="w-10 h-10 rounded object-cover"
                        />
                      ) : (
                        <div className="w-10 h-10 rounded bg-muted flex items-center justify-center">
                          <svg
                            className="w-5 h-5 text-muted-foreground"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
                            />
                          </svg>
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-foreground truncate">
                          {product.name}
                        </p>
                        <p className="text-xs text-muted-foreground">{product.sku}</p>
                      </div>
                      <span
                        className={`px-2 py-1 text-xs font-semibold rounded ${
                          product.inventory === 0
                            ? 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300'
                            : product.inventory <= 5
                              ? 'bg-orange-100 text-orange-800'
                              : 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300'
                        }`}
                      >
                        {product.inventory} left
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </AdminLayout>
  );
}
