'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { AdminLayout } from '../../../../components/AdminLayout';
import { apiGet } from '../../../../lib/api';

interface OrderCustomer {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
}

interface Order {
  id: string;
  orderNumber?: string;
  customer: OrderCustomer;
  total: number;
  createdAt: string;
}

interface CustomerRow {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  totalOrders: number;
  totalSpent: number;
  lastOrderDate: string;
  lastOrderId: string;
  lastOrderNumber?: string;
}

function formatDate(dateString: string) {
  return new Date(dateString).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export default function StoreCustomersPage() {
  const params = useParams();
  const storeId = params?.id as string;

  const [customers, setCustomers] = useState<CustomerRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  // Track whether we are still fetching additional pages beyond the first
  const [isFetchingAll, setIsFetchingAll] = useState(false);

  /**
   * Fetch all orders for the store across all pages, then deduplicate by
   * customer to build the customer list. The orders endpoint is paginated so
   * we loop until we have every page.
   */
  const fetchCustomers = useCallback(async () => {
    if (!storeId) return;
    setIsLoading(true);
    setError(null);

    try {
      const limit = 100;

      // Fetch first page to learn total
      const { data: firstData, error: firstError } = await apiGet<{
        orders: Order[];
        pagination: { totalPages: number };
      }>(`/api/v1/stores/${storeId}/orders?page=1&limit=${limit}`);

      if (firstError || !firstData) {
        setError(firstError?.message || 'Failed to fetch customers');
        return;
      }

      const allOrders: Order[] = firstData.orders ?? [];
      const totalPages: number = firstData.pagination?.totalPages ?? 1;

      // Fetch remaining pages in parallel if there are more
      if (totalPages > 1) {
        setIsFetchingAll(true);
        const pageNumbers = Array.from({ length: totalPages - 1 }, (_, i) => i + 2);
        const remainingResults = await Promise.all(
          pageNumbers.map(async pageNum => {
            const { data } = await apiGet<{ orders: Order[] }>(
              `/api/v1/stores/${storeId}/orders?page=${pageNum}&limit=${limit}`
            );
            return data?.orders ?? [];
          })
        );
        for (const pageOrders of remainingResults) {
          allOrders.push(...pageOrders);
        }
        setIsFetchingAll(false);
      }

      // Aggregate orders by customer
      const customerMap = new Map<string, CustomerRow>();

      for (const order of allOrders) {
        if (!order.customer?.id) continue;

        const existing = customerMap.get(order.customer.id);
        if (existing) {
          existing.totalOrders += 1;
          existing.totalSpent += order.total;
          // Keep track of the most recent order
          if (order.createdAt > existing.lastOrderDate) {
            existing.lastOrderDate = order.createdAt;
            existing.lastOrderId = order.id;
            existing.lastOrderNumber = order.orderNumber;
          }
        } else {
          customerMap.set(order.customer.id, {
            id: order.customer.id,
            firstName: order.customer.firstName,
            lastName: order.customer.lastName,
            email: order.customer.email,
            totalOrders: 1,
            totalSpent: order.total,
            lastOrderDate: order.createdAt,
            lastOrderId: order.id,
            lastOrderNumber: order.orderNumber,
          });
        }
      }

      // Sort by total spent descending
      const sorted = Array.from(customerMap.values()).sort((a, b) => b.totalSpent - a.totalSpent);
      setCustomers(sorted);
    } catch {
      setError('Unable to connect to the server. Please check your connection and try again.');
    } finally {
      setIsLoading(false);
    }
  }, [storeId]);

  useEffect(() => {
    fetchCustomers();
  }, [fetchCustomers]);

  const filteredCustomers = customers.filter(customer => {
    if (!search) return true;
    const s = search.toLowerCase();
    return (
      customer.firstName.toLowerCase().includes(s) ||
      customer.lastName.toLowerCase().includes(s) ||
      customer.email.toLowerCase().includes(s)
    );
  });

  return (
    <AdminLayout
      title="Customers"
      subtitle="Customers who have placed orders in this store"
      actions={
        <Link href={`/stores/${storeId}`}>
          <button className="px-4 py-2 text-sm border border-border rounded-lg hover:bg-muted font-medium">
            Back to Store
          </button>
        </Link>
      }
    >
      {/* Search bar */}
      <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">
            {isLoading || isFetchingAll
              ? 'Loading customers...'
              : `${filteredCustomers.length} customer${filteredCustomers.length !== 1 ? 's' : ''}`}
          </span>
          {isFetchingAll && (
            <div className="h-3 w-3 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          )}
        </div>

        <div className="relative w-full sm:w-72">
          <svg
            className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
          <input
            type="text"
            placeholder="Search by name or email..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full rounded-lg border py-2 pl-10 pr-4 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="mb-6 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}
          <button className="ml-4 font-medium underline" onClick={fetchCustomers}>
            Retry
          </button>
        </div>
      )}

      {/* Customers table */}
      <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
        {isLoading ? (
          <div className="space-y-4 p-6">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center gap-4 animate-pulse">
                <div className="h-10 w-10 rounded-full bg-gray-200" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 w-32 rounded bg-gray-200" />
                  <div className="h-3 w-48 rounded bg-gray-200" />
                </div>
                <div className="h-6 w-20 rounded bg-gray-200" />
                <div className="h-6 w-20 rounded bg-gray-200" />
              </div>
            ))}
          </div>
        ) : filteredCustomers.length === 0 ? (
          <div className="py-16 text-center">
            <svg
              className="mx-auto h-12 w-12 text-gray-300"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1}
                d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
              />
            </svg>
            <p className="mt-4 text-muted-foreground">
              {search ? 'No customers match your search' : 'No customers yet for this store'}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-muted border-b">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Customer
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Email
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Total Orders
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Total Spent
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider hidden md:table-cell">
                    Last Order
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filteredCustomers.map(customer => (
                  <tr key={customer.id} className="hover:bg-muted transition-colors">
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        {/* Avatar with initials */}
                        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary flex-shrink-0">
                          {customer.firstName?.[0]}
                          {customer.lastName?.[0]}
                        </div>
                        <p className="font-medium text-foreground">
                          {customer.firstName} {customer.lastName}
                        </p>
                      </div>
                    </td>
                    <td className="px-6 py-4 text-sm text-muted-foreground">{customer.email}</td>
                    <td className="px-6 py-4">
                      <span className="inline-flex items-center rounded-full bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700">
                        {customer.totalOrders} order{customer.totalOrders !== 1 ? 's' : ''}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <span className="font-bold text-foreground">
                        {(customer.totalSpent / 1000).toFixed(3)} KWD
                      </span>
                    </td>
                    <td className="px-6 py-4 hidden md:table-cell text-sm text-muted-foreground">
                      {formatDate(customer.lastOrderDate)}
                    </td>
                    <td className="px-6 py-4 text-right">
                      {/* Link to store orders filtered by this customer's name/email */}
                      <Link
                        href={`/stores/${storeId}/orders`}
                        className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-gray-700 border border-gray-200 rounded-lg hover:bg-muted transition-colors"
                        title="View orders for this customer"
                      >
                        <svg
                          className="h-3.5 w-3.5"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
                          />
                        </svg>
                        Orders
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
