'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { AdminLayout } from '../../../../components/AdminLayout';

interface ShippingZone {
  id: string;
  name: string;
  nameAr: string | null;
  areas: string[];
  areasAr: string[];
  deliveryFee: number;
  freeShippingThreshold: number | null;
  estimatedDays: number | null;
  estimatedDaysMin: number | null;
  estimatedDaysMax: number | null;
  position: number;
  isActive: boolean;
  createdAt: string;
}

interface ZoneFormData {
  name: string;
  nameAr: string;
  areas: string;
  areasAr: string;
  deliveryFee: string;
  freeShippingThreshold: string;
  estimatedDaysMin: string;
  estimatedDaysMax: string;
  isActive: boolean;
}

const KUWAIT_GOVERNORATES = [
  { en: 'Capital', ar: 'العاصمة' },
  { en: 'Hawalli', ar: 'حولي' },
  { en: 'Farwaniya', ar: 'الفروانية' },
  { en: 'Mubarak Al-Kabeer', ar: 'مبارك الكبير' },
  { en: 'Ahmadi', ar: 'الأحمدي' },
  { en: 'Jahra', ar: 'الجهراء' },
];

const DEFAULT_FORM: ZoneFormData = {
  name: '',
  nameAr: '',
  areas: '',
  areasAr: '',
  deliveryFee: '',
  freeShippingThreshold: '',
  estimatedDaysMin: '',
  estimatedDaysMax: '',
  isActive: true,
};

export default function ShippingSettingsPage() {
  const params = useParams();
  const storeId = params.id as string;

  const [zones, setZones] = useState<ShippingZone[]>([]);
  const [storeName, setStoreName] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [editingZone, setEditingZone] = useState<ShippingZone | null>(null);
  const [formData, setFormData] = useState<ZoneFormData>(DEFAULT_FORM);
  const [filter, setFilter] = useState<'all' | 'active' | 'inactive'>('all');

  const fetchStoreName = useCallback(async () => {
    try {
      const token = localStorage.getItem('authToken');
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api/v1'}/stores/${storeId}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      if (res.ok) {
        const data = await res.json();
        setStoreName(data.data?.store?.name || '');
      }
    } catch (err) {
      console.error('Failed to fetch store name:', err);
    }
  }, [storeId]);

  const fetchZones = useCallback(async () => {
    try {
      setLoading(true);
      const token = localStorage.getItem('authToken');
      const params = new URLSearchParams();
      if (filter === 'active') params.set('isActive', 'true');
      if (filter === 'inactive') params.set('isActive', 'false');

      const res = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api/v1'}/stores/${storeId}/shipping?${params}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (res.ok) {
        const data = await res.json();
        setZones(data.data?.zones || []);
      }
    } catch (err) {
      console.error('Failed to fetch shipping zones:', err);
    } finally {
      setLoading(false);
    }
  }, [storeId, filter]);

  useEffect(() => {
    fetchStoreName();
    fetchZones();
  }, [storeId, filter]);

  const handleOpenModal = (zone?: ShippingZone) => {
    if (zone) {
      setEditingZone(zone);
      setFormData({
        name: zone.name,
        nameAr: zone.nameAr || '',
        areas: zone.areas.join(', '),
        areasAr: zone.areasAr?.join(', ') || '',
        deliveryFee: (zone.deliveryFee / 1000).toFixed(3),
        freeShippingThreshold: zone.freeShippingThreshold
          ? (zone.freeShippingThreshold / 1000).toFixed(3)
          : '',
        estimatedDaysMin: zone.estimatedDaysMin?.toString() || '',
        estimatedDaysMax: zone.estimatedDaysMax?.toString() || '',
        isActive: zone.isActive,
      });
    } else {
      setEditingZone(null);
      setFormData(DEFAULT_FORM);
    }
    setShowModal(true);
  };

  const handleCloseModal = () => {
    setShowModal(false);
    setEditingZone(null);
    setFormData(DEFAULT_FORM);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);

    try {
      const token = localStorage.getItem('authToken');
      const areas = formData.areas
        .split(',')
        .map(a => a.trim())
        .filter(Boolean);
      const areasAr = formData.areasAr
        .split(',')
        .map(a => a.trim())
        .filter(Boolean);

      const body = {
        name: formData.name,
        nameAr: formData.nameAr || undefined,
        areas,
        areasAr: areasAr.length > 0 ? areasAr : undefined,
        deliveryFee: Math.round(parseFloat(formData.deliveryFee || '0') * 1000),
        freeShippingThreshold: formData.freeShippingThreshold
          ? Math.round(parseFloat(formData.freeShippingThreshold) * 1000)
          : undefined,
        estimatedDaysMin: formData.estimatedDaysMin
          ? parseInt(formData.estimatedDaysMin)
          : undefined,
        estimatedDaysMax: formData.estimatedDaysMax
          ? parseInt(formData.estimatedDaysMax)
          : undefined,
        isActive: formData.isActive,
      };

      const url = editingZone
        ? `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api/v1'}/stores/${storeId}/shipping/${editingZone.id}`
        : `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api/v1'}/stores/${storeId}/shipping`;

      const res = await fetch(url, {
        method: editingZone ? 'PUT' : 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        handleCloseModal();
        fetchZones();
      }
    } catch (err) {
      console.error('Failed to save shipping zone:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (zone: ShippingZone) => {
    try {
      const token = localStorage.getItem('authToken');
      await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api/v1'}/stores/${storeId}/shipping/${zone.id}/toggle`,
        {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      fetchZones();
    } catch (err) {
      console.error('Failed to toggle shipping zone:', err);
    }
  };

  const handleDelete = async (zone: ShippingZone) => {
    if (!confirm(`Delete shipping zone "${zone.name}"? This cannot be undone.`)) return;

    try {
      const token = localStorage.getItem('authToken');
      await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api/v1'}/stores/${storeId}/shipping/${zone.id}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      fetchZones();
    } catch (err) {
      console.error('Failed to delete shipping zone:', err);
    }
  };

  const addGovernorateAreas = () => {
    const areas = KUWAIT_GOVERNORATES.map(g => g.en).join(', ');
    const areasAr = KUWAIT_GOVERNORATES.map(g => g.ar).join(', ');
    setFormData(prev => ({
      ...prev,
      areas: prev.areas ? `${prev.areas}, ${areas}` : areas,
      areasAr: prev.areasAr ? `${prev.areasAr}, ${areasAr}` : areasAr,
    }));
  };

  const formatDeliveryTime = (zone: ShippingZone) => {
    if (zone.estimatedDaysMin && zone.estimatedDaysMax) {
      return `${zone.estimatedDaysMin}-${zone.estimatedDaysMax} days`;
    }
    if (zone.estimatedDays) {
      return `${zone.estimatedDays} days`;
    }
    return '-';
  };

  return (
    <AdminLayout
      title="Shipping Zones"
      subtitle="Configure delivery areas and shipping rates"
      actions={
        <button
          onClick={() => handleOpenModal()}
          className="px-4 py-2 bg-orange-500 text-white rounded-lg hover:bg-orange-600 transition-colors flex items-center gap-2"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Add Zone
        </button>
      }
    >
      <div className="space-y-6">
        {/* Filters */}
        <div className="flex gap-2 mb-6">
          {(['all', 'active', 'inactive'] as const).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                filter === f
                  ? 'bg-orange-500 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>

        {/* Zones List */}
        {loading ? (
          <div className="flex items-center justify-center h-64">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-orange-500"></div>
          </div>
        ) : zones.length === 0 ? (
          <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
            <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg
                className="w-8 h-8 text-gray-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
                />
              </svg>
            </div>
            <h3 className="text-lg font-semibold text-gray-900 mb-2">No Shipping Zones</h3>
            <p className="text-gray-600 mb-6">
              Create shipping zones to configure delivery rates for different areas
            </p>
            <button
              onClick={() => handleOpenModal()}
              className="px-4 py-2 bg-orange-500 text-white rounded-lg hover:bg-orange-600 transition-colors"
            >
              Create First Zone
            </button>
          </div>
        ) : (
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Zone
                  </th>
                  <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Areas
                  </th>
                  <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Delivery Fee
                  </th>
                  <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Free Shipping
                  </th>
                  <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Est. Delivery
                  </th>
                  <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Status
                  </th>
                  <th className="text-right px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {zones.map(zone => (
                  <tr key={zone.id} className="hover:bg-gray-50">
                    <td className="px-6 py-4">
                      <div>
                        <div className="font-medium text-gray-900">{zone.name}</div>
                        {zone.nameAr && (
                          <div className="text-sm text-gray-500 font-arabic">{zone.nameAr}</div>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex flex-wrap gap-1 max-w-xs">
                        {zone.areas.slice(0, 3).map((area, i) => (
                          <span
                            key={i}
                            className="px-2 py-0.5 bg-gray-100 text-gray-700 text-xs rounded"
                          >
                            {area}
                          </span>
                        ))}
                        {zone.areas.length > 3 && (
                          <span className="px-2 py-0.5 bg-gray-100 text-gray-500 text-xs rounded">
                            +{zone.areas.length - 3} more
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <span className="font-medium text-gray-900">
                        {(zone.deliveryFee / 1000).toFixed(3)} KWD
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      {zone.freeShippingThreshold ? (
                        <span className="text-green-600 text-sm">
                          Over {(zone.freeShippingThreshold / 1000).toFixed(3)} KWD
                        </span>
                      ) : (
                        <span className="text-gray-400">-</span>
                      )}
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-600">{formatDeliveryTime(zone)}</td>
                    <td className="px-6 py-4">
                      <button
                        onClick={() => handleToggle(zone)}
                        className={`px-2 py-1 rounded-full text-xs font-medium ${
                          zone.isActive
                            ? 'bg-green-100 text-green-700'
                            : 'bg-gray-100 text-gray-600'
                        }`}
                      >
                        {zone.isActive ? 'Active' : 'Inactive'}
                      </button>
                    </td>
                    <td className="px-6 py-4 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={() => handleOpenModal(zone)}
                          className="p-2 text-gray-500 hover:text-orange-500 transition-colors"
                          title="Edit"
                        >
                          <svg
                            className="w-4 h-4"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
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
                          onClick={() => handleDelete(zone)}
                          className="p-2 text-gray-500 hover:text-red-500 transition-colors"
                          title="Delete"
                        >
                          <svg
                            className="w-4 h-4"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
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
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Modal */}
        {showModal && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
              <div className="flex items-center justify-between p-6 border-b border-gray-200">
                <h2 className="text-xl font-semibold text-gray-900">
                  {editingZone ? 'Edit Shipping Zone' : 'New Shipping Zone'}
                </h2>
                <button
                  onClick={handleCloseModal}
                  className="p-2 text-gray-400 hover:text-gray-600 transition-colors"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                </button>
              </div>

              <form onSubmit={handleSubmit} className="p-6 space-y-6">
                {/* Zone Name */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Zone Name <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      value={formData.name}
                      onChange={e => setFormData({ ...formData, name: e.target.value })}
                      placeholder="e.g., Capital Area"
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Zone Name (Arabic)
                    </label>
                    <input
                      type="text"
                      value={formData.nameAr}
                      onChange={e => setFormData({ ...formData, nameAr: e.target.value })}
                      placeholder="e.g., منطقة العاصمة"
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                      dir="rtl"
                    />
                  </div>
                </div>

                {/* Areas */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="block text-sm font-medium text-gray-700">
                      Areas <span className="text-red-500">*</span>
                    </label>
                    <button
                      type="button"
                      onClick={addGovernorateAreas}
                      className="text-xs text-orange-500 hover:text-orange-600"
                    >
                      + Add All Kuwait Governorates
                    </button>
                  </div>
                  <textarea
                    value={formData.areas}
                    onChange={e => setFormData({ ...formData, areas: e.target.value })}
                    placeholder="Separate areas with commas: Capital, Hawalli, Farwaniya"
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                    rows={2}
                    required
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Areas (Arabic)
                  </label>
                  <textarea
                    value={formData.areasAr}
                    onChange={e => setFormData({ ...formData, areasAr: e.target.value })}
                    placeholder="العاصمة، حولي، الفروانية"
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                    rows={2}
                    dir="rtl"
                  />
                </div>

                {/* Delivery Fee */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Delivery Fee (KWD) <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="number"
                      step="0.001"
                      min="0"
                      value={formData.deliveryFee}
                      onChange={e => setFormData({ ...formData, deliveryFee: e.target.value })}
                      placeholder="1.000"
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Free Shipping Over (KWD)
                    </label>
                    <input
                      type="number"
                      step="0.001"
                      min="0"
                      value={formData.freeShippingThreshold}
                      onChange={e =>
                        setFormData({ ...formData, freeShippingThreshold: e.target.value })
                      }
                      placeholder="25.000"
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                    />
                  </div>
                </div>

                {/* Delivery Time */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Estimated Delivery Time (Days)
                  </label>
                  <div className="grid grid-cols-2 gap-4">
                    <input
                      type="number"
                      min="1"
                      value={formData.estimatedDaysMin}
                      onChange={e => setFormData({ ...formData, estimatedDaysMin: e.target.value })}
                      placeholder="Min days"
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                    />
                    <input
                      type="number"
                      min="1"
                      value={formData.estimatedDaysMax}
                      onChange={e => setFormData({ ...formData, estimatedDaysMax: e.target.value })}
                      placeholder="Max days"
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                    />
                  </div>
                </div>

                {/* Active Status */}
                <div className="flex items-center gap-3">
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      checked={formData.isActive}
                      onChange={e => setFormData({ ...formData, isActive: e.target.checked })}
                      className="sr-only peer"
                    />
                    <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-orange-300 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-orange-500"></div>
                  </label>
                  <span className="text-sm text-gray-700">Active</span>
                </div>

                {/* Actions */}
                <div className="flex items-center justify-end gap-3 pt-4 border-t border-gray-200">
                  <button
                    type="button"
                    onClick={handleCloseModal}
                    className="px-4 py-2 text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={saving}
                    className="px-4 py-2 bg-orange-500 text-white rounded-lg hover:bg-orange-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                  >
                    {saving && (
                      <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                    )}
                    {editingZone ? 'Update Zone' : 'Create Zone'}
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
