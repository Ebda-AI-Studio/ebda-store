'use client';

import { useState, useEffect, useCallback } from 'react';
import { AdminLayout } from '../../components/AdminLayout';
import { formatPrice, formatNumber } from '../../lib/format';
import { getApiUrl } from '../../lib/api';

const API_URL = getApiUrl();

interface Store {
  id: string;
  name: string;
}

interface DashboardStats {
  totalOrders: number;
  totalRevenue: number;
  averageOrderValue: number;
  totalCustomers: number;
}

interface SalesDataPoint {
  date: string;
  total: number;
  count: number;
}

interface TopProduct {
  id: string;
  name: string;
  totalSold: number;
  revenue: number;
}

interface OrdersByStatus {
  status: string;
  count: number;
}

function getDateRange(range: string) {
  const end = new Date();
  const start = new Date();

  switch (range) {
    case 'today':
      start.setHours(0, 0, 0, 0);
      break;
    case 'last7days':
      start.setDate(start.getDate() - 7);
      break;
    case 'last30days':
      start.setDate(start.getDate() - 30);
      break;
    case 'last90days':
      start.setDate(start.getDate() - 90);
      break;
    case 'thisYear':
      start.setMonth(0, 1);
      start.setHours(0, 0, 0, 0);
      break;
    default:
      start.setDate(start.getDate() - 7);
  }

  return {
    startDate: start.toISOString(),
    endDate: end.toISOString(),
  };
}

export default function ReportsPage() {
  const [dateRange, setDateRange] = useState('last30days');
  const [selectedStore, setSelectedStore] = useState<string>('');
  const [stores, setStores] = useState<Store[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const [dashboardStats, setDashboardStats] = useState<DashboardStats | null>(null);
  const [salesData, setSalesData] = useState<SalesDataPoint[]>([]);
  const [topProducts, setTopProducts] = useState<TopProduct[]>([]);
  const [ordersByStatus, setOrdersByStatus] = useState<OrdersByStatus[]>([]);

  const getAuthHeaders = useCallback(() => {
    const token = localStorage.getItem('authToken');
    return { Authorization: `Bearer ${token}` };
  }, []);

  // Fetch stores list
  useEffect(() => {
    async function fetchStores() {
      try {
        const response = await fetch(`${API_URL}/api/v1/stores?limit=100`, {
          headers: getAuthHeaders(),
        });
        if (response.ok) {
          const data = await response.json();
          const storeList = data.data?.stores || [];
          setStores(storeList);
          if (storeList.length > 0 && !selectedStore) {
            setSelectedStore(storeList[0].id);
          }
        }
      } catch (error) {
        console.error('Failed to fetch stores:', error);
        alert('Failed to load stores. Please refresh the page.');
      }
    }
    fetchStores();
  }, [getAuthHeaders, selectedStore]);

  // Fetch analytics data when store or date range changes
  useEffect(() => {
    if (!selectedStore) return;

    async function fetchAnalytics() {
      setIsLoading(true);
      const { startDate, endDate } = getDateRange(dateRange);
      const headers = getAuthHeaders();
      const dateQuery = `startDate=${startDate}&endDate=${endDate}`;
      const base = `${API_URL}/api/v1/stores/${selectedStore}/analytics`;

      try {
        const [dashRes, salesRes, productsRes, ordersRes] = await Promise.all([
          fetch(`${base}/dashboard?${dateQuery}`, { headers }),
          fetch(`${base}/sales?${dateQuery}&period=day`, { headers }),
          fetch(`${base}/top-products?${dateQuery}&limit=10`, { headers }),
          fetch(`${base}/orders-by-status?${dateQuery}`, { headers }),
        ]);

        if (dashRes.ok) {
          const d = await dashRes.json();
          setDashboardStats(d.data?.stats || null);
        }
        if (salesRes.ok) {
          const d = await salesRes.json();
          setSalesData(d.data?.sales || []);
        }
        if (productsRes.ok) {
          const d = await productsRes.json();
          setTopProducts(d.data?.products || []);
        }
        if (ordersRes.ok) {
          const d = await ordersRes.json();
          setOrdersByStatus(d.data?.orders || []);
        }
      } catch (error) {
        console.error('Failed to fetch analytics:', error);
        alert('Failed to load analytics data. Please try again.');
      } finally {
        setIsLoading(false);
      }
    }
    fetchAnalytics();
  }, [selectedStore, dateRange, getAuthHeaders]);

  const maxSales = salesData.length > 0 ? Math.max(...salesData.map(d => d.total)) : 1;

  return (
    <AdminLayout
      title="Reports"
      subtitle="Analytics and insights across all stores"
      actions={
        <div className="flex items-center gap-3">
          <select
            value={selectedStore}
            onChange={e => setSelectedStore(e.target.value)}
            className="rounded-xl border border-input bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
          >
            {stores.map(store => (
              <option key={store.id} value={store.id}>
                {store.name}
              </option>
            ))}
          </select>
          <select
            value={dateRange}
            onChange={e => setDateRange(e.target.value)}
            className="rounded-xl border border-input bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
          >
            <option value="today">Today</option>
            <option value="last7days">Last 7 Days</option>
            <option value="last30days">Last 30 Days</option>
            <option value="last90days">Last 90 Days</option>
            <option value="thisYear">This Year</option>
          </select>
        </div>
      }
    >
      {isLoading ? (
        <div className="flex items-center justify-center py-20">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
        </div>
      ) : (
        <>
          {/* Summary Stats */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
            <div className="force-card p-5 text-center">
              <div className="text-3xl font-bold text-blue-600">
                {dashboardStats ? formatPrice(dashboardStats.totalRevenue) : '--'}
              </div>
              <div className="text-sm text-muted-foreground mt-1">Total Revenue</div>
            </div>
            <div className="force-card p-5 text-center">
              <div className="text-3xl font-bold text-emerald-600">
                {dashboardStats ? formatNumber(dashboardStats.totalOrders) : '--'}
              </div>
              <div className="text-sm text-muted-foreground mt-1">Orders</div>
            </div>
            <div className="force-card p-5 text-center">
              <div className="text-3xl font-bold text-violet-600">
                {dashboardStats ? formatNumber(dashboardStats.totalCustomers) : '--'}
              </div>
              <div className="text-sm text-muted-foreground mt-1">Customers</div>
            </div>
            <div className="force-card p-5 text-center">
              <div className="text-3xl font-bold text-primary">
                {dashboardStats ? formatPrice(dashboardStats.averageOrderValue) : '--'}
              </div>
              <div className="text-sm text-muted-foreground mt-1">Avg Order Value</div>
            </div>
          </div>

          {/* Sales Chart (bar chart with CSS) */}
          <div className="force-card p-6 mb-8">
            <h2 className="text-lg font-semibold mb-4">Sales Over Time</h2>
            {salesData.length > 0 ? (
              <div className="flex items-end gap-1 h-48">
                {salesData.map((d, i) => (
                  <div key={i} className="flex-1 flex flex-col items-center group relative">
                    <div className="absolute -top-8 bg-foreground text-background text-xs px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap z-10">
                      {formatPrice(d.total)} ({d.count} orders)
                    </div>
                    <div
                      className="w-full bg-primary/80 rounded-t hover:bg-primary transition-colors min-h-[2px]"
                      style={{ height: `${(d.total / maxSales) * 100}%` }}
                    />
                    {salesData.length <= 14 && (
                      <span className="text-[10px] text-muted-foreground mt-1 rotate-45 origin-left">
                        {new Date(d.date).toLocaleDateString('en-US', {
                          month: 'short',
                          day: 'numeric',
                        })}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-muted-foreground text-sm text-center py-10">
                No sales data for this period
              </p>
            )}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Top Products */}
            <div className="force-card p-6">
              <h2 className="text-lg font-semibold mb-4">Top Products</h2>
              {topProducts.length > 0 ? (
                <div className="space-y-3">
                  {topProducts.map((product, i) => (
                    <div key={product.id} className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <span className="text-sm font-medium text-muted-foreground w-6">
                          #{i + 1}
                        </span>
                        <span className="text-sm font-medium truncate max-w-[200px]">
                          {product.name}
                        </span>
                      </div>
                      <div className="text-right">
                        <div className="text-sm font-semibold">{formatPrice(product.revenue)}</div>
                        <div className="text-xs text-muted-foreground">
                          {product.totalSold} sold
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-muted-foreground text-sm text-center py-6">
                  No product data available
                </p>
              )}
            </div>

            {/* Orders by Status */}
            <div className="force-card p-6">
              <h2 className="text-lg font-semibold mb-4">Orders by Status</h2>
              {ordersByStatus.length > 0 ? (
                <div className="space-y-3">
                  {ordersByStatus.map(item => {
                    const total = ordersByStatus.reduce((sum, o) => sum + o.count, 0);
                    const percentage = total > 0 ? (item.count / total) * 100 : 0;
                    const statusColors: Record<string, string> = {
                      pending: 'bg-yellow-500',
                      confirmed: 'bg-blue-500',
                      processing: 'bg-indigo-500',
                      shipped: 'bg-purple-500',
                      delivered: 'bg-emerald-500',
                      cancelled: 'bg-red-500',
                      refunded: 'bg-gray-500',
                    };
                    return (
                      <div key={item.status}>
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-sm capitalize">{item.status}</span>
                          <span className="text-sm font-medium">
                            {item.count} ({percentage.toFixed(1)}%)
                          </span>
                        </div>
                        <div className="h-2 bg-muted rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full ${statusColors[item.status] || 'bg-primary'}`}
                            style={{ width: `${percentage}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-muted-foreground text-sm text-center py-6">
                  No order data available
                </p>
              )}
            </div>
          </div>
        </>
      )}
    </AdminLayout>
  );
}
