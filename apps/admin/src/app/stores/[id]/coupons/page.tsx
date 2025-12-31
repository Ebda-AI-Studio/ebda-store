'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import { AdminLayout } from '../../../../components/AdminLayout';

interface Coupon {
  id: string;
  code: string;
  name: string;
  nameAr?: string;
  description?: string;
  type: 'percentage' | 'fixed' | 'free_shipping';
  value: number;
  minOrderAmount?: number;
  maxDiscount?: number;
  usageLimit?: number;
  usageCount: number;
  usageLimitPerUser?: number;
  isActive: boolean;
  startsAt?: string;
  expiresAt?: string;
  createdAt: string;
}

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api/v1';

export default function CouponsPage() {
  const params = useParams();
  const storeId = params?.id as string;

  const [coupons, setCoupons] = useState<Coupon[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingCoupon, setEditingCoupon] = useState<Coupon | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterActive, setFilterActive] = useState<'all' | 'active' | 'inactive'>('all');
  const [storeName, setStoreName] = useState('');

  // Form state
  const [formData, setFormData] = useState({
    code: '',
    name: '',
    nameAr: '',
    description: '',
    type: 'percentage' as 'percentage' | 'fixed' | 'free_shipping',
    value: 0,
    minOrderAmount: '',
    maxDiscount: '',
    usageLimit: '',
    usageLimitPerUser: '',
    isActive: true,
    startsAt: '',
    expiresAt: '',
  });

  useEffect(() => {
    fetchCoupons();
    fetchStoreName();
  }, [storeId]);

  async function fetchStoreName() {
    try {
      const token = localStorage.getItem('authToken');
      const response = await fetch(`${API_URL}/stores/${storeId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await response.json();
      if (data.success) {
        setStoreName(data.data.store.name);
      }
    } catch (error) {
      console.error('Failed to fetch store:', error);
    }
  }

  async function fetchCoupons() {
    try {
      const token = localStorage.getItem('authToken');
      const params = new URLSearchParams();
      if (searchTerm) params.append('search', searchTerm);
      if (filterActive !== 'all')
        params.append('isActive', filterActive === 'active' ? 'true' : 'false');

      const response = await fetch(`${API_URL}/stores/${storeId}/coupons?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await response.json();

      if (data.success) {
        setCoupons(data.data.coupons);
      }
    } catch (error) {
      console.error('Failed to fetch coupons:', error);
    } finally {
      setIsLoading(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    try {
      const token = localStorage.getItem('authToken');
      const url = editingCoupon
        ? `${API_URL}/stores/${storeId}/coupons/${editingCoupon.id}`
        : `${API_URL}/stores/${storeId}/coupons`;

      const body = {
        code: formData.code,
        name: formData.name,
        nameAr: formData.nameAr || undefined,
        description: formData.description || undefined,
        type: formData.type,
        value: formData.value,
        minOrderAmount: formData.minOrderAmount
          ? parseInt(formData.minOrderAmount) * 1000
          : undefined,
        maxDiscount: formData.maxDiscount ? parseInt(formData.maxDiscount) * 1000 : undefined,
        usageLimit: formData.usageLimit ? parseInt(formData.usageLimit) : undefined,
        usageLimitPerUser: formData.usageLimitPerUser
          ? parseInt(formData.usageLimitPerUser)
          : undefined,
        isActive: formData.isActive,
        startsAt: formData.startsAt ? new Date(formData.startsAt).toISOString() : undefined,
        expiresAt: formData.expiresAt ? new Date(formData.expiresAt).toISOString() : undefined,
      };

      const response = await fetch(url, {
        method: editingCoupon ? 'PUT' : 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });

      if (response.ok) {
        setShowModal(false);
        resetForm();
        fetchCoupons();
      } else {
        const data = await response.json();
        alert(data.error?.message || 'Failed to save coupon');
      }
    } catch (error) {
      console.error('Failed to save coupon:', error);
      alert('Failed to save coupon');
    }
  }

  async function handleDelete(couponId: string) {
    if (!confirm('Are you sure you want to delete this coupon?')) return;

    try {
      const token = localStorage.getItem('authToken');
      const response = await fetch(`${API_URL}/stores/${storeId}/coupons/${couponId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });

      if (response.ok) {
        fetchCoupons();
      }
    } catch (error) {
      console.error('Failed to delete coupon:', error);
    }
  }

  async function handleToggleActive(couponId: string) {
    try {
      const token = localStorage.getItem('authToken');
      const response = await fetch(`${API_URL}/stores/${storeId}/coupons/${couponId}/toggle`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}` },
      });

      if (response.ok) {
        fetchCoupons();
      }
    } catch (error) {
      console.error('Failed to toggle coupon:', error);
    }
  }

  function resetForm() {
    setFormData({
      code: '',
      name: '',
      nameAr: '',
      description: '',
      type: 'percentage',
      value: 0,
      minOrderAmount: '',
      maxDiscount: '',
      usageLimit: '',
      usageLimitPerUser: '',
      isActive: true,
      startsAt: '',
      expiresAt: '',
    });
    setEditingCoupon(null);
  }

  function openEditModal(coupon: Coupon) {
    setEditingCoupon(coupon);
    setFormData({
      code: coupon.code,
      name: coupon.name,
      nameAr: coupon.nameAr || '',
      description: coupon.description || '',
      type: coupon.type,
      value: coupon.value,
      minOrderAmount: coupon.minOrderAmount ? String(coupon.minOrderAmount / 1000) : '',
      maxDiscount: coupon.maxDiscount ? String(coupon.maxDiscount / 1000) : '',
      usageLimit: coupon.usageLimit ? String(coupon.usageLimit) : '',
      usageLimitPerUser: coupon.usageLimitPerUser ? String(coupon.usageLimitPerUser) : '',
      isActive: coupon.isActive,
      startsAt: coupon.startsAt ? coupon.startsAt.slice(0, 16) : '',
      expiresAt: coupon.expiresAt ? coupon.expiresAt.slice(0, 16) : '',
    });
    setShowModal(true);
  }

  function formatValue(coupon: Coupon): string {
    if (coupon.type === 'percentage') return `${coupon.value}%`;
    if (coupon.type === 'fixed') return `${(coupon.value / 1000).toFixed(3)} KWD`;
    return 'Free Shipping';
  }

  function getCouponStatus(coupon: Coupon): { label: string; color: string } {
    if (!coupon.isActive) return { label: 'Inactive', color: 'bg-gray-100 text-gray-800' };

    const now = new Date();
    if (coupon.startsAt && new Date(coupon.startsAt) > now) {
      return { label: 'Scheduled', color: 'bg-blue-100 text-blue-800' };
    }
    if (coupon.expiresAt && new Date(coupon.expiresAt) < now) {
      return { label: 'Expired', color: 'bg-red-100 text-red-800' };
    }
    if (coupon.usageLimit && coupon.usageCount >= coupon.usageLimit) {
      return { label: 'Exhausted', color: 'bg-amber-100 text-amber-800' };
    }
    return { label: 'Active', color: 'bg-green-100 text-green-800' };
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  return (
    <AdminLayout
      title="Discount Coupons"
      subtitle="Manage promotional codes and discounts"
      actions={
        <button
          onClick={() => {
            resetForm();
            setShowModal(true);
          }}
          className="px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary/90 font-medium flex items-center gap-2"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Create Coupon
        </button>
      }
    >
      <div className="space-y-6">
        {/* Filters */}
        <div className="flex gap-4 items-center">
          <div className="flex-1">
            <input
              type="text"
              placeholder="Search coupons..."
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && fetchCoupons()}
              className="w-full max-w-md px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary"
            />
          </div>
          <select
            value={filterActive}
            onChange={e => {
              setFilterActive(e.target.value as typeof filterActive);
              setTimeout(fetchCoupons, 0);
            }}
            className="px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary"
          >
            <option value="all">All Status</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
        </div>

        {/* Coupons Table */}
        <div className="bg-white rounded-xl border overflow-hidden">
          {coupons.length === 0 ? (
            <div className="text-center py-12">
              <div className="mx-auto w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mb-4">
                <svg
                  className="w-8 h-8 text-gray-400"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 110 4v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 110-4V7a2 2 0 00-2-2H5z"
                  />
                </svg>
              </div>
              <p className="text-gray-500">No coupons found</p>
              <button
                onClick={() => {
                  resetForm();
                  setShowModal(true);
                }}
                className="mt-4 text-primary hover:underline"
              >
                Create your first coupon
              </button>
            </div>
          ) : (
            <table className="w-full">
              <thead className="bg-gray-50 border-b">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Code
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Name
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Type
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Value
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Usage
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Status
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {coupons.map(coupon => {
                  const status = getCouponStatus(coupon);
                  return (
                    <tr key={coupon.id} className="hover:bg-gray-50">
                      <td className="px-6 py-4">
                        <span className="font-mono text-sm bg-gray-100 px-2 py-1 rounded">
                          {coupon.code}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <div>
                          <p className="font-medium text-gray-900">{coupon.name}</p>
                          {coupon.nameAr && (
                            <p className="text-sm text-gray-500" dir="rtl">
                              {coupon.nameAr}
                            </p>
                          )}
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <span className="capitalize text-sm text-gray-600">
                          {coupon.type.replace('_', ' ')}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <span className="font-medium text-primary">{formatValue(coupon)}</span>
                      </td>
                      <td className="px-6 py-4">
                        <span className="text-sm text-gray-600">
                          {coupon.usageCount}
                          {coupon.usageLimit && ` / ${coupon.usageLimit}`}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <span
                          className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${status.color}`}
                        >
                          {status.label}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <button
                            onClick={() => handleToggleActive(coupon.id)}
                            className={`p-2 rounded-lg transition-colors ${
                              coupon.isActive
                                ? 'text-amber-600 hover:bg-amber-50'
                                : 'text-green-600 hover:bg-green-50'
                            }`}
                            title={coupon.isActive ? 'Deactivate' : 'Activate'}
                          >
                            {coupon.isActive ? (
                              <svg
                                className="w-5 h-5"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  strokeWidth={2}
                                  d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"
                                />
                              </svg>
                            ) : (
                              <svg
                                className="w-5 h-5"
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
                            )}
                          </button>
                          <button
                            onClick={() => openEditModal(coupon)}
                            className="p-2 text-gray-600 hover:bg-gray-100 rounded-lg"
                            title="Edit"
                          >
                            <svg
                              className="w-5 h-5"
                              fill="none"
                              viewBox="0 0 24 24"
                              stroke="currentColor"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                              />
                            </svg>
                          </button>
                          <button
                            onClick={() => handleDelete(coupon.id)}
                            className="p-2 text-red-600 hover:bg-red-50 rounded-lg"
                            title="Delete"
                          >
                            <svg
                              className="w-5 h-5"
                              fill="none"
                              viewBox="0 0 24 24"
                              stroke="currentColor"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                              />
                            </svg>
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Modal */}
        {showModal && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
              <div className="p-6 border-b sticky top-0 bg-white">
                <h2 className="text-xl font-bold">
                  {editingCoupon ? 'Edit Coupon' : 'Create Coupon'}
                </h2>
              </div>

              <form onSubmit={handleSubmit} className="p-6 space-y-6">
                {/* Basic Info */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Coupon Code *
                    </label>
                    <input
                      type="text"
                      required
                      value={formData.code}
                      onChange={e =>
                        setFormData({ ...formData, code: e.target.value.toUpperCase() })
                      }
                      placeholder="SUMMER20"
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary font-mono uppercase"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Name *</label>
                    <input
                      type="text"
                      required
                      value={formData.name}
                      onChange={e => setFormData({ ...formData, name: e.target.value })}
                      placeholder="Summer Sale 20% Off"
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Name (Arabic)
                    </label>
                    <input
                      type="text"
                      dir="rtl"
                      value={formData.nameAr}
                      onChange={e => setFormData({ ...formData, nameAr: e.target.value })}
                      placeholder="خصم الصيف ٢٠٪"
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Description
                    </label>
                    <input
                      type="text"
                      value={formData.description}
                      onChange={e => setFormData({ ...formData, description: e.target.value })}
                      placeholder="Get 20% off on all summer items"
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary"
                    />
                  </div>
                </div>

                {/* Discount Type & Value */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Discount Type *
                    </label>
                    <select
                      value={formData.type}
                      onChange={e =>
                        setFormData({ ...formData, type: e.target.value as typeof formData.type })
                      }
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary"
                    >
                      <option value="percentage">Percentage Off</option>
                      <option value="fixed">Fixed Amount</option>
                      <option value="free_shipping">Free Shipping</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      {formData.type === 'percentage' ? 'Percentage (%)' : 'Amount (KWD)'} *
                    </label>
                    <input
                      type="number"
                      required
                      min="0"
                      max={formData.type === 'percentage' ? 100 : undefined}
                      value={formData.value}
                      onChange={e =>
                        setFormData({ ...formData, value: parseFloat(e.target.value) || 0 })
                      }
                      disabled={formData.type === 'free_shipping'}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary disabled:bg-gray-100"
                    />
                  </div>
                </div>

                {/* Limits */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Minimum Order (KWD)
                    </label>
                    <input
                      type="number"
                      min="0"
                      step="0.001"
                      value={formData.minOrderAmount}
                      onChange={e => setFormData({ ...formData, minOrderAmount: e.target.value })}
                      placeholder="10.000"
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary"
                    />
                  </div>
                  {formData.type === 'percentage' && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Max Discount (KWD)
                      </label>
                      <input
                        type="number"
                        min="0"
                        step="0.001"
                        value={formData.maxDiscount}
                        onChange={e => setFormData({ ...formData, maxDiscount: e.target.value })}
                        placeholder="50.000"
                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary"
                      />
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Total Usage Limit
                    </label>
                    <input
                      type="number"
                      min="1"
                      value={formData.usageLimit}
                      onChange={e => setFormData({ ...formData, usageLimit: e.target.value })}
                      placeholder="100"
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Limit Per Customer
                    </label>
                    <input
                      type="number"
                      min="1"
                      value={formData.usageLimitPerUser}
                      onChange={e =>
                        setFormData({ ...formData, usageLimitPerUser: e.target.value })
                      }
                      placeholder="1"
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary"
                    />
                  </div>
                </div>

                {/* Date Range */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Start Date
                    </label>
                    <input
                      type="datetime-local"
                      value={formData.startsAt}
                      onChange={e => setFormData({ ...formData, startsAt: e.target.value })}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Expiry Date
                    </label>
                    <input
                      type="datetime-local"
                      value={formData.expiresAt}
                      onChange={e => setFormData({ ...formData, expiresAt: e.target.value })}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary"
                    />
                  </div>
                </div>

                {/* Active Toggle */}
                <div className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    id="isActive"
                    checked={formData.isActive}
                    onChange={e => setFormData({ ...formData, isActive: e.target.checked })}
                    className="w-4 h-4 text-primary border-gray-300 rounded focus:ring-primary"
                  />
                  <label htmlFor="isActive" className="text-sm font-medium text-gray-700">
                    Coupon is active
                  </label>
                </div>

                {/* Actions */}
                <div className="flex gap-3 pt-4 border-t">
                  <button
                    type="button"
                    onClick={() => {
                      setShowModal(false);
                      resetForm();
                    }}
                    className="flex-1 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="flex-1 px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary/90"
                  >
                    {editingCoupon ? 'Update Coupon' : 'Create Coupon'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
