'use client';

import { useEffect, useState, useCallback } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@force/ui';
import { AdminLayout } from '../../components/AdminLayout';
import { getApiUrl } from '../../lib/api';
import { useStore } from '../../contexts/StoreContext';

const API_URL = getApiUrl();

type DateRange = 'today' | '7d' | '30d' | '90d' | 'year';

interface DashboardData {
  totalRevenue: number;
  totalOrders: number;
  totalCustomers: number;
  averageOrderValue: number;
}

interface SalesData {
  period: string;
  revenue: number;
  orders: number;
}

interface TopProduct {
  id: string;
  name: string;
  totalSold: number;
  revenue: number;
}

interface TopCategory {
  name: string;
  totalSold: number;
  revenue: number;
}

interface OrdersByStatus {
  status: string;
  count: number;
}

interface RecentOrder {
  id: string;
  orderNumber: string;
  total: number;
  status: string;
  createdAt: string;
  customer: { firstName: string; lastName: string; email: string };
}

interface LowStockItem {
  id: string;
  name: string;
  stock: number;
  sku: string;
}

function formatPrice(amount: number) {
  return new Intl.NumberFormat('en-KW', {
    style: 'currency',
    currency: 'KWD',
    minimumFractionDigits: 3,
  }).format(amount / 1000);
}

function formatNumber(num: number) {
  return new Intl.NumberFormat('en-US').format(num);
}

function formatDate(date: string) {
  return new Date(date).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function getDateRangeParams(range: DateRange): { startDate: string; endDate: string } {
  const now = new Date();
  const end = now.toISOString();
  let start: Date;

  switch (range) {
    case 'today':
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      break;
    case '7d':
      start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      break;
    case '30d':
      start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      break;
    case '90d':
      start = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
      break;
    case 'year':
      start = new Date(now.getFullYear(), 0, 1);
      break;
  }

  return { startDate: start.toISOString(), endDate: end };
}

const dateRangeLabels: Record<DateRange, string> = {
  today: 'Today',
  '7d': 'Last 7 Days',
  '30d': 'Last 30 Days',
  '90d': 'Last 90 Days',
  year: 'This Year',
};

export default function AnalyticsPage() {
  const { stores, selectedStoreId: globalStoreId, isLoading: isLoadingStores } = useStore();
  // Analytics requires a specific store
  const selectedStoreId = globalStoreId !== 'all' ? globalStoreId : '';
  const storeName = stores.find(s => s.id === selectedStoreId)?.name;
  const [dateRange, setDateRange] = useState<DateRange>('30d');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Analytics data
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [sales, setSales] = useState<SalesData[]>([]);
  const [topProducts, setTopProducts] = useState<TopProduct[]>([]);
  const [topCategories, setTopCategories] = useState<TopCategory[]>([]);
  const [ordersByStatus, setOrdersByStatus] = useState<OrdersByStatus[]>([]);
  const [recentOrders, setRecentOrders] = useState<RecentOrder[]>([]);
  const [lowStock, setLowStock] = useState<LowStockItem[]>([]);

  // Fetch analytics data for selected store
  const fetchAnalytics = useCallback(async () => {
    if (!selectedStoreId) return;

    setIsLoading(true);
    setError(null);

    const token = localStorage.getItem('authToken');
    const headers = { Authorization: `Bearer ${token}` };
    const { startDate, endDate } = getDateRangeParams(dateRange);
    const baseUrl = `${API_URL}/api/v1/stores/${selectedStoreId}/analytics`;
    const qs = `?startDate=${startDate}&endDate=${endDate}`;

    try {
      const [
        dashboardRes,
        salesRes,
        topProductsRes,
        topCategoriesRes,
        ordersByStatusRes,
        recentOrdersRes,
        lowStockRes,
      ] = await Promise.allSettled([
        fetch(`${baseUrl}/dashboard${qs}`, { headers }),
        fetch(`${baseUrl}/sales${qs}`, { headers }),
        fetch(`${baseUrl}/top-products${qs}`, { headers }),
        fetch(`${baseUrl}/top-categories${qs}`, { headers }),
        fetch(`${baseUrl}/orders-by-status${qs}`, { headers }),
        fetch(`${baseUrl}/recent-orders${qs}`, { headers }),
        fetch(`${baseUrl}/low-stock`, { headers }),
      ]);

      // Process dashboard
      if (dashboardRes.status === 'fulfilled' && dashboardRes.value.ok) {
        const data = await dashboardRes.value.json();
        setDashboard(data.data || data);
      }

      // Process sales
      if (salesRes.status === 'fulfilled' && salesRes.value.ok) {
        const data = await salesRes.value.json();
        setSales(Array.isArray(data.data) ? data.data : []);
      }

      // Process top products
      if (topProductsRes.status === 'fulfilled' && topProductsRes.value.ok) {
        const data = await topProductsRes.value.json();
        setTopProducts(Array.isArray(data.data) ? data.data : []);
      }

      // Process top categories
      if (topCategoriesRes.status === 'fulfilled' && topCategoriesRes.value.ok) {
        const data = await topCategoriesRes.value.json();
        setTopCategories(Array.isArray(data.data) ? data.data : []);
      }

      // Process orders by status
      if (ordersByStatusRes.status === 'fulfilled' && ordersByStatusRes.value.ok) {
        const data = await ordersByStatusRes.value.json();
        setOrdersByStatus(Array.isArray(data.data) ? data.data : []);
      }

      // Process recent orders
      if (recentOrdersRes.status === 'fulfilled' && recentOrdersRes.value.ok) {
        const data = await recentOrdersRes.value.json();
        setRecentOrders(Array.isArray(data.data) ? data.data : []);
      }

      // Process low stock
      if (lowStockRes.status === 'fulfilled' && lowStockRes.value.ok) {
        const data = await lowStockRes.value.json();
        setLowStock(Array.isArray(data.data) ? data.data : []);
      }
    } catch {
      setError('Failed to load analytics data');
    } finally {
      setIsLoading(false);
    }
  }, [selectedStoreId, dateRange]);

  useEffect(() => {
    fetchAnalytics();
  }, [fetchAnalytics]);

  const maxRevenue = sales.length > 0 ? Math.max(...sales.map(s => s.revenue)) : 0;
  const totalStatusOrders = ordersByStatus.reduce((sum, o) => sum + o.count, 0);

  const statusColors: Record<string, string> = {
    pending: 'bg-yellow-500',
    processing: 'bg-blue-500',
    shipped: 'bg-indigo-500',
    delivered: 'bg-green-500',
    completed: 'bg-emerald-500',
    paid: 'bg-green-500',
    cancelled: 'bg-red-500',
    refunded: 'bg-gray-500',
  };

  if (isLoadingStores) {
    return (
      <AdminLayout title="Analytics" subtitle="Track your store performance">
        <div className="flex items-center justify-center py-24">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        </div>
      </AdminLayout>
    );
  }

  if (stores.length === 0) {
    return (
      <AdminLayout title="Analytics" subtitle="Track your store performance">
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <p className="text-lg font-medium text-gray-900">No stores found</p>
          <p className="mt-2 text-sm text-gray-500">Create a store to view analytics.</p>
        </div>
      </AdminLayout>
    );
  }

  if (!selectedStoreId) {
    return (
      <AdminLayout title="Analytics" subtitle="Track your store performance">
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <svg
            className="mx-auto h-12 w-12 text-gray-400"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          <h3 className="mt-4 text-sm font-medium text-gray-900">Select a store</h3>
          <p className="mt-1 text-sm text-gray-500">
            Analytics are per-store. Please select a specific store from the sidebar.
          </p>
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout
      title="Analytics"
      subtitle={storeName ? `Performance for ${storeName}` : 'Track your store performance'}
      actions={
        <select
          value={dateRange}
          onChange={e => setDateRange(e.target.value as DateRange)}
          className="rounded-lg border bg-white px-3 py-2 text-sm font-medium shadow-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
        >
          {Object.entries(dateRangeLabels).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
      }
    >
      {error && (
        <div className="mb-6 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}
          <button onClick={fetchAnalytics} className="ml-2 font-medium underline">
            Retry
          </button>
        </div>
      )}

      {isLoading ? (
        <div className="space-y-6">
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="h-28 animate-pulse rounded-xl bg-gray-200" />
            ))}
          </div>
          <div className="h-72 animate-pulse rounded-xl bg-gray-200" />
          <div className="grid gap-6 lg:grid-cols-2">
            <div className="h-64 animate-pulse rounded-xl bg-gray-200" />
            <div className="h-64 animate-pulse rounded-xl bg-gray-200" />
          </div>
        </div>
      ) : (
        <>
          {/* Overview Stats */}
          <div className="mb-8 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Total Revenue</CardDescription>
                <CardTitle className="text-2xl text-primary">
                  {formatPrice(dashboard?.totalRevenue || 0)}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-xs text-muted-foreground">{dateRangeLabels[dateRange]}</p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Total Orders</CardDescription>
                <CardTitle className="text-2xl">
                  {formatNumber(dashboard?.totalOrders || 0)}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-xs text-muted-foreground">{dateRangeLabels[dateRange]}</p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Total Customers</CardDescription>
                <CardTitle className="text-2xl">
                  {formatNumber(dashboard?.totalCustomers || 0)}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-xs text-muted-foreground">{dateRangeLabels[dateRange]}</p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Average Order Value</CardDescription>
                <CardTitle className="text-2xl">
                  {formatPrice(dashboard?.averageOrderValue || 0)}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-xs text-muted-foreground">{dateRangeLabels[dateRange]}</p>
              </CardContent>
            </Card>
          </div>

          {/* Charts Section */}
          <div className="grid gap-6 lg:grid-cols-2">
            {/* Revenue Chart */}
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle>Sales Over Time</CardTitle>
                <CardDescription>
                  Revenue for {dateRangeLabels[dateRange].toLowerCase()}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {sales.length > 0 ? (
                  <div className="h-64">
                    <div className="flex h-full items-end gap-2">
                      {sales.map(item => (
                        <div key={item.period} className="flex-1 flex flex-col items-center gap-2">
                          <div
                            className="w-full bg-gradient-to-t from-primary to-orange-400 rounded-t transition-all hover:from-primary/80 hover:to-orange-300"
                            style={{
                              height:
                                maxRevenue > 0 ? `${(item.revenue / maxRevenue) * 100}%` : '0%',
                              minHeight: item.revenue > 0 ? '4px' : '0px',
                            }}
                            title={`${item.period}: ${formatPrice(item.revenue)} (${item.orders} orders)`}
                          />
                          <span className="text-xs text-gray-500 truncate w-full text-center">
                            {item.period}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="flex h-64 items-center justify-center text-gray-500">
                    No sales data for this period
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Top Products */}
            <Card>
              <CardHeader>
                <CardTitle>Top Products</CardTitle>
                <CardDescription>Best selling products</CardDescription>
              </CardHeader>
              <CardContent>
                {topProducts.length > 0 ? (
                  <div className="space-y-4">
                    {topProducts.map((product, index) => (
                      <div key={product.id} className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">
                            {index + 1}
                          </span>
                          <div>
                            <p className="text-sm font-medium text-gray-900 line-clamp-1">
                              {product.name}
                            </p>
                            <p className="text-xs text-gray-500">{product.totalSold} sold</p>
                          </div>
                        </div>
                        <span className="text-sm font-semibold text-primary">
                          {formatPrice(product.revenue)}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="py-8 text-center text-sm text-gray-500">No product data</p>
                )}
              </CardContent>
            </Card>

            {/* Top Categories */}
            <Card>
              <CardHeader>
                <CardTitle>Sales by Category</CardTitle>
                <CardDescription>Category performance</CardDescription>
              </CardHeader>
              <CardContent>
                {topCategories.length > 0 ? (
                  <div className="space-y-4">
                    {topCategories.map(category => {
                      const maxCatRevenue = Math.max(...topCategories.map(c => c.revenue));
                      const percentage =
                        maxCatRevenue > 0 ? (category.revenue / maxCatRevenue) * 100 : 0;
                      return (
                        <div key={category.name}>
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-sm font-medium text-gray-700">
                              {category.name}
                            </span>
                            <span className="text-sm text-gray-500">
                              {category.totalSold} sold - {formatPrice(category.revenue)}
                            </span>
                          </div>
                          <div className="h-2 w-full rounded-full bg-gray-100">
                            <div
                              className="h-2 rounded-full bg-primary transition-all"
                              style={{ width: `${percentage}%` }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="py-8 text-center text-sm text-gray-500">No category data</p>
                )}
              </CardContent>
            </Card>

            {/* Orders by Status */}
            <Card>
              <CardHeader>
                <CardTitle>Orders by Status</CardTitle>
                <CardDescription>Order status breakdown</CardDescription>
              </CardHeader>
              <CardContent>
                {ordersByStatus.length > 0 ? (
                  <div className="space-y-4">
                    {ordersByStatus.map(item => (
                      <div key={item.status} className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div
                            className={`h-3 w-3 rounded-full ${statusColors[item.status] || 'bg-gray-400'}`}
                          />
                          <span className="text-sm font-medium text-gray-700 capitalize">
                            {item.status}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-semibold text-gray-900">{item.count}</span>
                          <span className="text-xs text-gray-500">
                            (
                            {totalStatusOrders > 0
                              ? Math.round((item.count / totalStatusOrders) * 100)
                              : 0}
                            %)
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="py-8 text-center text-sm text-gray-500">No order data</p>
                )}
              </CardContent>
            </Card>

            {/* Low Stock */}
            <Card>
              <CardHeader>
                <CardTitle>Low Stock Items</CardTitle>
                <CardDescription>Products running low on inventory</CardDescription>
              </CardHeader>
              <CardContent>
                {lowStock.length > 0 ? (
                  <div className="space-y-3">
                    {lowStock.map(item => (
                      <div
                        key={item.id}
                        className="flex items-center justify-between rounded-lg border p-3"
                      >
                        <div>
                          <p className="text-sm font-medium text-gray-900 line-clamp-1">
                            {item.name}
                          </p>
                          {item.sku && <p className="text-xs text-gray-500">SKU: {item.sku}</p>}
                        </div>
                        <span
                          className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                            item.stock === 0
                              ? 'bg-red-100 text-red-700'
                              : item.stock <= 5
                                ? 'bg-orange-100 text-orange-700'
                                : 'bg-yellow-100 text-yellow-700'
                          }`}
                        >
                          {item.stock} left
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="py-8 text-center text-sm text-gray-500">No low stock items</p>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Recent Orders */}
          <Card className="mt-6">
            <CardHeader>
              <CardTitle>Recent Orders</CardTitle>
              <CardDescription>Latest orders for this store</CardDescription>
            </CardHeader>
            <CardContent>
              {recentOrders.length > 0 ? (
                <div className="space-y-3">
                  {recentOrders.map(order => (
                    <div
                      key={order.id}
                      className="flex items-center justify-between rounded-lg border p-3"
                    >
                      <div className="flex items-center gap-3">
                        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                          <svg
                            className="h-5 w-5 text-primary"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={1.5}
                              d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
                            />
                          </svg>
                        </div>
                        <div>
                          <p className="text-sm font-medium text-gray-900">
                            {order.orderNumber || `#${order.id.slice(0, 8).toUpperCase()}`}
                          </p>
                          <p className="text-xs text-gray-500">
                            {order.customer?.firstName} {order.customer?.lastName} -{' '}
                            {formatDate(order.createdAt)}
                          </p>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="text-sm font-semibold text-primary">
                          {formatPrice(order.total)}
                        </p>
                        <span
                          className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium capitalize ${
                            order.status === 'paid' || order.status === 'completed'
                              ? 'bg-green-100 text-green-700'
                              : order.status === 'cancelled'
                                ? 'bg-red-100 text-red-700'
                                : 'bg-yellow-100 text-yellow-700'
                          }`}
                        >
                          {order.status}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="py-8 text-center text-sm text-gray-500">No recent orders</p>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </AdminLayout>
  );
}
