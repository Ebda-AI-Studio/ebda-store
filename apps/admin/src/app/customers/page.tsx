'use client';

import { useState, useEffect, useCallback } from 'react';
import { Button, Input, Modal } from '@force/ui';
import { AdminLayout } from '../../components/AdminLayout';
import { ErrorState } from '../../components/ErrorState';
import { useAuth } from '../../lib/auth';
import { getApiUrl } from '../../lib/api';
import { useStore } from '../../contexts/StoreContext';

interface Customer {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  totalOrders: number;
  totalSpent: number;
  createdAt: string;
  store: {
    id: string;
    name: string;
  };
}

interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

function formatPrice(fils: number) {
  return new Intl.NumberFormat('en-KW', {
    style: 'currency',
    currency: 'KWD',
    minimumFractionDigits: 3,
  }).format(fils / 1000);
}

function formatDate(dateString: string) {
  return new Date(dateString).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export default function CustomersPage() {
  const { token } = useAuth();
  const { selectedStoreId, stores: globalStores } = useStore();
  const storeName =
    selectedStoreId !== 'all' ? globalStores.find(s => s.id === selectedStoreId)?.name : null;
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [pagination, setPagination] = useState<Pagination>({
    page: 1,
    limit: 20,
    total: 0,
    totalPages: 0,
  });
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [isDetailModalOpen, setIsDetailModalOpen] = useState(false);

  const fetchCustomers = useCallback(async () => {
    if (!token) return;

    try {
      setError(null);
      setIsLoading(true);
      const params = new URLSearchParams({
        page: pagination.page.toString(),
        limit: pagination.limit.toString(),
      });
      if (search) params.append('search', search);
      if (selectedStoreId !== 'all') params.append('storeId', selectedStoreId);

      const response = await fetch(`${getApiUrl()}/api/v1/admin/customers?${params}`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (response.ok) {
        const data = await response.json();
        setCustomers(data.data.customers || []);
        if (data.data.pagination) {
          setPagination(prev => ({ ...prev, ...data.data.pagination }));
        }
      } else {
        const errorData = await response.json().catch(() => ({}));
        setError(errorData.error?.message || 'Failed to fetch customers');
      }
    } catch (error) {
      console.error('Failed to fetch customers:', error);
      setError('Unable to connect to the server. Please check your connection and try again.');
    } finally {
      setIsLoading(false);
    }
  }, [token, pagination.page, pagination.limit, search, selectedStoreId]);

  useEffect(() => {
    fetchCustomers();
  }, [fetchCustomers]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setPagination(prev => ({ ...prev, page: 1 }));
    fetchCustomers();
  };

  const viewCustomerDetails = (customer: Customer) => {
    setSelectedCustomer(customer);
    setIsDetailModalOpen(true);
  };

  const filteredCustomers = customers;

  // Calculate stats from customers
  const stats = {
    total: pagination.total,
    totalRevenue: customers.reduce((sum, c) => sum + c.totalSpent, 0),
    avgOrderValue:
      customers.length > 0
        ? customers.reduce(
            (sum, c) => sum + (c.totalOrders > 0 ? c.totalSpent / c.totalOrders : 0),
            0
          ) / customers.length
        : 0,
    topSpenders: customers.filter(c => c.totalSpent > 100000).length, // > 100 KWD
  };

  return (
    <AdminLayout
      title="Customers"
      subtitle={`${pagination.total} registered customers${storeName ? ` for ${storeName}` : ' across all stores'}`}
    >
      {/* Stats */}
      <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div className="force-card">
          <p className="text-sm text-muted-foreground">Total Customers</p>
          <p className="text-2xl font-bold text-foreground">{stats.total}</p>
        </div>
        <div className="force-card">
          <p className="text-sm text-muted-foreground">Total Revenue</p>
          <p className="text-2xl font-bold text-primary">{formatPrice(stats.totalRevenue)}</p>
        </div>
        <div className="force-card">
          <p className="text-sm text-muted-foreground">Avg Order Value</p>
          <p className="text-2xl font-bold text-foreground">{formatPrice(stats.avgOrderValue)}</p>
        </div>
        <div className="force-card">
          <p className="text-sm text-muted-foreground">High Value</p>
          <p className="text-2xl font-bold text-violet-600">{stats.topSpenders}</p>
        </div>
      </div>

      {/* Search */}
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <form onSubmit={handleSearch} className="flex gap-2 w-full sm:w-auto">
          <div className="w-full sm:w-80">
            <Input
              placeholder="Search by name or email..."
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
          <Button type="submit" variant="outline" size="sm">
            Search
          </Button>
        </form>
      </div>

      {/* Error State */}
      {error && !isLoading && (
        <ErrorState title="Failed to load customers" message={error} onRetry={fetchCustomers} />
      )}

      {/* Loading State */}
      {!error && isLoading ? (
        <div className="force-card p-0 overflow-hidden">
          <div className="space-y-4 p-6">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center gap-4 animate-pulse">
                <div className="h-10 w-10 rounded-full bg-muted" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 w-32 rounded bg-muted" />
                  <div className="h-3 w-48 rounded bg-muted" />
                </div>
                <div className="h-4 w-20 rounded bg-muted" />
              </div>
            ))}
          </div>
        </div>
      ) : !error && filteredCustomers.length > 0 ? (
        <>
          {/* Customers Table */}
          <div className="force-card p-0 overflow-hidden">
            <table className="min-w-full divide-y divide-border/50">
              <thead className="bg-muted/50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    Customer
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider hidden md:table-cell">
                    Store
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    Orders
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    Total Spent
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider hidden sm:table-cell">
                    Joined
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50 bg-background">
                {filteredCustomers.map(customer => (
                  <tr key={customer.id} className="hover:bg-muted/30 transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-sm font-medium text-primary">
                          {customer.firstName?.[0]}
                          {customer.lastName?.[0]}
                        </div>
                        <div>
                          <p className="font-medium text-foreground">
                            {customer.firstName} {customer.lastName}
                          </p>
                          <p className="text-xs text-muted-foreground">{customer.email}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 hidden md:table-cell">
                      <span className="text-sm text-muted-foreground">
                        {customer.store?.name || 'N/A'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-sm font-medium text-foreground">
                        {customer.totalOrders} orders
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="font-semibold text-foreground">
                        {formatPrice(customer.totalSpent)}
                      </span>
                    </td>
                    <td className="px-4 py-3 hidden sm:table-cell">
                      <span className="text-sm text-muted-foreground">
                        {formatDate(customer.createdAt)}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => viewCustomerDetails(customer)}
                        >
                          <svg
                            className="h-4 w-4"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                            />
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
                            />
                          </svg>
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {pagination.totalPages > 1 && (
            <div className="mt-4 flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                Showing{' '}
                <span className="font-medium text-foreground">
                  {(pagination.page - 1) * pagination.limit + 1}
                </span>{' '}
                to{' '}
                <span className="font-medium text-foreground">
                  {Math.min(pagination.page * pagination.limit, pagination.total)}
                </span>{' '}
                of <span className="font-medium text-foreground">{pagination.total}</span> customers
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-xl"
                  disabled={pagination.page === 1}
                  onClick={() => setPagination(prev => ({ ...prev, page: prev.page - 1 }))}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-xl"
                  disabled={pagination.page === pagination.totalPages}
                  onClick={() => setPagination(prev => ({ ...prev, page: prev.page + 1 }))}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </>
      ) : !error ? (
        /* Empty State */
        <div className="force-card py-16">
          <div className="flex flex-col items-center text-center">
            <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-3xl bg-gradient-to-br from-primary/20 to-primary/5">
              <svg
                className="h-10 w-10 text-primary"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z"
                />
              </svg>
            </div>
            <h3 className="text-xl font-semibold text-foreground mb-2">No customers found</h3>
            <p className="text-muted-foreground mb-6 max-w-sm">
              {search
                ? 'Try adjusting your search criteria'
                : 'Customers will appear here when they register on your stores'}
            </p>
          </div>
        </div>
      ) : null}

      {/* Customer Detail Modal */}
      <Modal
        isOpen={isDetailModalOpen}
        onClose={() => setIsDetailModalOpen(false)}
        title="Customer Details"
      >
        {selectedCustomer && (
          <div className="space-y-6">
            {/* Profile */}
            <div className="flex items-center gap-4">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary/10 text-xl font-bold text-primary">
                {selectedCustomer.firstName?.[0]}
                {selectedCustomer.lastName?.[0]}
              </div>
              <div>
                <h3 className="text-lg font-semibold text-foreground">
                  {selectedCustomer.firstName} {selectedCustomer.lastName}
                </h3>
                <p className="text-sm text-muted-foreground">{selectedCustomer.email}</p>
              </div>
            </div>

            {/* Store */}
            <div className="rounded-xl bg-muted/30 p-4">
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                Store
              </h4>
              <p className="font-medium text-foreground">{selectedCustomer.store?.name || 'N/A'}</p>
            </div>

            {/* Contact */}
            <div>
              <h4 className="text-sm font-medium text-muted-foreground mb-2">
                Contact Information
              </h4>
              <p className="text-sm text-foreground">
                {selectedCustomer.phone || 'No phone provided'}
              </p>
              <p className="text-sm text-foreground">{selectedCustomer.email}</p>
            </div>

            {/* Stats */}
            <div className="grid grid-cols-2 gap-4">
              <div className="rounded-xl bg-muted/30 p-4">
                <p className="text-xs text-muted-foreground">Total Orders</p>
                <p className="text-xl font-bold text-foreground">{selectedCustomer.totalOrders}</p>
              </div>
              <div className="rounded-xl bg-muted/30 p-4">
                <p className="text-xs text-muted-foreground">Total Spent</p>
                <p className="text-xl font-bold text-primary">
                  {formatPrice(selectedCustomer.totalSpent)}
                </p>
              </div>
            </div>

            {/* Dates */}
            <div className="text-sm">
              <p className="text-muted-foreground">Customer Since</p>
              <p className="font-medium text-foreground">
                {formatDate(selectedCustomer.createdAt)}
              </p>
            </div>

            <div className="flex justify-end gap-3 pt-4 border-t">
              <Button
                variant="outline"
                className="rounded-xl"
                onClick={() => setIsDetailModalOpen(false)}
              >
                Close
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </AdminLayout>
  );
}
