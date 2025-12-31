'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { AdminLayout } from '../../../../components/AdminLayout';

interface InventoryStats {
  totalProducts: number;
  totalStock: number;
  lowStockCount: number;
  outOfStockCount: number;
  totalValue: number;
}

interface ProductInventory {
  id: string;
  name: string;
  nameAr: string | null;
  sku: string | null;
  inventory: number;
  lowStockThreshold: number;
  trackInventory: boolean;
  costPrice: number | null;
  status: string;
  stockStatus: 'in_stock' | 'low_stock' | 'out_of_stock';
  stockValue: number;
}

interface HistoryItem {
  id: string;
  type: string;
  quantity: number;
  previousStock: number;
  newStock: number;
  reason: string | null;
  reference: string | null;
  createdAt: string;
  product?: { name: string; sku: string | null };
}

const STOCK_STATUS_STYLES = {
  in_stock: { bg: 'bg-green-100', text: 'text-green-700', label: 'In Stock' },
  low_stock: { bg: 'bg-yellow-100', text: 'text-yellow-700', label: 'Low Stock' },
  out_of_stock: { bg: 'bg-red-100', text: 'text-red-700', label: 'Out of Stock' },
};

const ADJUSTMENT_TYPES = [
  { value: 'manual_add', label: 'Add Stock', sign: '+' },
  { value: 'manual_remove', label: 'Remove Stock', sign: '-' },
  { value: 'damage', label: 'Damaged', sign: '-' },
  { value: 'adjustment', label: 'Adjustment', sign: '±' },
];

export default function InventoryPage() {
  const params = useParams();
  const storeId = params.id as string;

  const [storeName, setStoreName] = useState('');
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState<InventoryStats | null>(null);
  const [products, setProducts] = useState<ProductInventory[]>([]);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [alerts, setAlerts] = useState<ProductInventory[]>([]);

  const [activeTab, setActiveTab] = useState<'products' | 'history' | 'alerts'>('products');
  const [stockFilter, setStockFilter] = useState<'all' | 'in_stock' | 'low_stock' | 'out_of_stock'>('all');
  const [search, setSearch] = useState('');

  const [showAdjustModal, setShowAdjustModal] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState<ProductInventory | null>(null);
  const [adjustType, setAdjustType] = useState('manual_add');
  const [adjustQuantity, setAdjustQuantity] = useState('');
  const [adjustReason, setAdjustReason] = useState('');
  const [saving, setSaving] = useState(false);

  const fetchStoreName = useCallback(async () => {
    try {
      const token = localStorage.getItem('authToken');
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api/v1'}/stores/${storeId}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setStoreName(data.data?.store?.name || '');
      }
    } catch (err) {
      console.error('Failed to fetch store name:', err);
    }
  }, [storeId]);

  const fetchStats = useCallback(async () => {
    try {
      const token = localStorage.getItem('authToken');
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api/v1'}/stores/${storeId}/inventory/stats`,
        { headers: { 'Authorization': `Bearer ${token}` } }
      );
      if (res.ok) {
        const data = await res.json();
        setStats(data.data?.stats || null);
      }
    } catch (err) {
      console.error('Failed to fetch stats:', err);
    }
  }, [storeId]);

  const fetchProducts = useCallback(async () => {
    try {
      const token = localStorage.getItem('authToken');
      const params = new URLSearchParams();
      if (stockFilter !== 'all') params.set('stockFilter', stockFilter);
      if (search) params.set('search', search);
      params.set('sortBy', 'inventory');
      params.set('sortOrder', 'asc');

      const res = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api/v1'}/stores/${storeId}/inventory/products?${params}`,
        { headers: { 'Authorization': `Bearer ${token}` } }
      );
      if (res.ok) {
        const data = await res.json();
        setProducts(data.data?.products || []);
      }
    } catch (err) {
      console.error('Failed to fetch products:', err);
    }
  }, [storeId, stockFilter, search]);

  const fetchHistory = useCallback(async () => {
    try {
      const token = localStorage.getItem('authToken');
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api/v1'}/stores/${storeId}/inventory/history?limit=50`,
        { headers: { 'Authorization': `Bearer ${token}` } }
      );
      if (res.ok) {
        const data = await res.json();
        setHistory(data.data?.history || []);
      }
    } catch (err) {
      console.error('Failed to fetch history:', err);
    }
  }, [storeId]);

  const fetchAlerts = useCallback(async () => {
    try {
      const token = localStorage.getItem('authToken');
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api/v1'}/stores/${storeId}/inventory/alerts`,
        { headers: { 'Authorization': `Bearer ${token}` } }
      );
      if (res.ok) {
        const data = await res.json();
        setAlerts(data.data?.alerts || []);
      }
    } catch (err) {
      console.error('Failed to fetch alerts:', err);
    }
  }, [storeId]);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    await Promise.all([fetchStoreName(), fetchStats(), fetchProducts(), fetchHistory(), fetchAlerts()]);
    setLoading(false);
  }, [fetchStoreName, fetchStats, fetchProducts, fetchHistory, fetchAlerts]);

  useEffect(() => {
    fetchAll();
  }, [storeId]);

  useEffect(() => {
    if (!loading) {
      fetchProducts();
    }
  }, [stockFilter, search]);

  const handleAdjust = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedProduct) return;

    setSaving(true);
    try {
      const token = localStorage.getItem('authToken');
      let quantity = parseInt(adjustQuantity);

      // Make negative for remove types
      if (['manual_remove', 'damage'].includes(adjustType)) {
        quantity = -Math.abs(quantity);
      }

      const res = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api/v1'}/stores/${storeId}/inventory/adjust`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({
            productId: selectedProduct.id,
            quantity,
            type: adjustType,
            reason: adjustReason || undefined,
          }),
        }
      );

      if (res.ok) {
        setShowAdjustModal(false);
        setSelectedProduct(null);
        setAdjustQuantity('');
        setAdjustReason('');
        setAdjustType('manual_add');
        fetchStats();
        fetchProducts();
        fetchHistory();
        fetchAlerts();
      }
    } catch (err) {
      console.error('Failed to adjust inventory:', err);
    } finally {
      setSaving(false);
    }
  };

  const formatChangeType = (type: string) => {
    const labels: Record<string, string> = {
      manual_add: 'Added',
      manual_remove: 'Removed',
      sale: 'Sale',
      return_stock: 'Returned',
      adjustment: 'Adjusted',
      damage: 'Damaged',
      transfer_in: 'Transfer In',
      transfer_out: 'Transfer Out',
      initial: 'Initial',
    };
    return labels[type] || type;
  };

  return (
    <AdminLayout
      title="Inventory Management"
      subtitle="Track and manage your product stock levels"
    >
      {loading ? (
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-orange-500"></div>
        </div>
      ) : (
        <>
          {/* Stats Cards */}
          {stats && (
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
              <div className="bg-white rounded-xl border border-gray-200 p-4">
                <p className="text-sm text-gray-500">Total Products</p>
                <p className="text-2xl font-bold text-gray-900">{stats.totalProducts}</p>
              </div>
              <div className="bg-white rounded-xl border border-gray-200 p-4">
                <p className="text-sm text-gray-500">Total Stock</p>
                <p className="text-2xl font-bold text-blue-600">{stats.totalStock.toLocaleString()}</p>
              </div>
              <div className="bg-white rounded-xl border border-gray-200 p-4">
                <p className="text-sm text-gray-500">Low Stock</p>
                <p className="text-2xl font-bold text-yellow-600">{stats.lowStockCount}</p>
              </div>
              <div className="bg-white rounded-xl border border-gray-200 p-4">
                <p className="text-sm text-gray-500">Out of Stock</p>
                <p className="text-2xl font-bold text-red-600">{stats.outOfStockCount}</p>
              </div>
              <div className="bg-white rounded-xl border border-gray-200 p-4">
                <p className="text-sm text-gray-500">Stock Value</p>
                <p className="text-2xl font-bold text-green-600">{(stats.totalValue / 1000).toFixed(3)} KWD</p>
              </div>
            </div>
          )}

          {/* Low Stock Alert Banner */}
          {alerts.length > 0 && (
            <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-4 mb-6">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-yellow-100 rounded-full flex items-center justify-center">
                  <svg className="w-5 h-5 text-yellow-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                </div>
                <div className="flex-1">
                  <p className="font-medium text-yellow-800">
                    {alerts.length} product{alerts.length > 1 ? 's' : ''} need attention
                  </p>
                  <p className="text-sm text-yellow-700">
                    {alerts.filter(a => a.stockStatus === 'out_of_stock').length} out of stock, {' '}
                    {alerts.filter(a => a.stockStatus === 'low_stock').length} low stock
                  </p>
                </div>
                <button
                  onClick={() => setActiveTab('alerts')}
                  className="px-4 py-2 bg-yellow-100 text-yellow-800 rounded-lg hover:bg-yellow-200 text-sm font-medium"
                >
                  View Alerts
                </button>
              </div>
            </div>
          )}

          {/* Tabs */}
          <div className="flex gap-2 mb-6">
            <button
              onClick={() => setActiveTab('products')}
              className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                activeTab === 'products'
                  ? 'bg-orange-500 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              Products
            </button>
            <button
              onClick={() => setActiveTab('history')}
              className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                activeTab === 'history'
                  ? 'bg-orange-500 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              History
            </button>
            <button
              onClick={() => setActiveTab('alerts')}
              className={`px-4 py-2 rounded-lg font-medium transition-colors relative ${
                activeTab === 'alerts'
                  ? 'bg-orange-500 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              Alerts
              {alerts.length > 0 && (
                <span className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 text-white text-xs rounded-full flex items-center justify-center">
                  {alerts.length}
                </span>
              )}
            </button>
          </div>

          {/* Products Tab */}
          {activeTab === 'products' && (
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              {/* Filters */}
              <div className="flex flex-wrap gap-4 p-4 bg-gray-50 border-b border-gray-200">
                <div className="flex-1 min-w-[200px]">
                  <input
                    type="text"
                    placeholder="Search products..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                  />
                </div>
                <div className="flex gap-2">
                  {(['all', 'in_stock', 'low_stock', 'out_of_stock'] as const).map((filter) => (
                    <button
                      key={filter}
                      onClick={() => setStockFilter(filter)}
                      className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                        stockFilter === filter
                          ? 'bg-orange-500 text-white'
                          : 'bg-white text-gray-700 hover:bg-gray-100 border border-gray-200'
                      }`}
                    >
                      {filter === 'all' ? 'All' : STOCK_STATUS_STYLES[filter].label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Products Table */}
              {products.length === 0 ? (
                <div className="p-12 text-center">
                  <p className="text-gray-500">No products found</p>
                </div>
              ) : (
                <table className="w-full">
                  <thead>
                    <tr className="bg-gray-50 border-b border-gray-200">
                      <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Product</th>
                      <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">SKU</th>
                      <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Stock</th>
                      <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Threshold</th>
                      <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                      <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Value</th>
                      <th className="text-right px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200">
                    {products.map((product) => (
                      <tr key={product.id} className="hover:bg-gray-50">
                        <td className="px-6 py-4">
                          <div>
                            <div className="font-medium text-gray-900">{product.name}</div>
                            {product.nameAr && <div className="text-sm text-gray-500 font-arabic">{product.nameAr}</div>}
                          </div>
                        </td>
                        <td className="px-6 py-4 text-sm text-gray-600">
                          {product.sku || '-'}
                        </td>
                        <td className="px-6 py-4">
                          <span className="font-semibold text-gray-900">{product.inventory}</span>
                        </td>
                        <td className="px-6 py-4 text-sm text-gray-600">
                          {product.lowStockThreshold}
                        </td>
                        <td className="px-6 py-4">
                          <span className={`px-2 py-1 rounded-full text-xs font-medium ${STOCK_STATUS_STYLES[product.stockStatus].bg} ${STOCK_STATUS_STYLES[product.stockStatus].text}`}>
                            {STOCK_STATUS_STYLES[product.stockStatus].label}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-sm text-gray-600">
                          {product.costPrice ? `${(product.stockValue / 1000).toFixed(3)} KWD` : '-'}
                        </td>
                        <td className="px-6 py-4 text-right">
                          <button
                            onClick={() => {
                              setSelectedProduct(product);
                              setShowAdjustModal(true);
                            }}
                            className="text-orange-500 hover:text-orange-600 text-sm font-medium"
                          >
                            Adjust
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {/* History Tab */}
          {activeTab === 'history' && (
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              {history.length === 0 ? (
                <div className="p-12 text-center">
                  <p className="text-gray-500">No inventory history yet</p>
                </div>
              ) : (
                <table className="w-full">
                  <thead>
                    <tr className="bg-gray-50 border-b border-gray-200">
                      <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Date</th>
                      <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Product</th>
                      <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Type</th>
                      <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Change</th>
                      <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Stock</th>
                      <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Reason</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200">
                    {history.map((item) => (
                      <tr key={item.id} className="hover:bg-gray-50">
                        <td className="px-6 py-4 text-sm text-gray-600">
                          {new Date(item.createdAt).toLocaleDateString('en-US', {
                            month: 'short',
                            day: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </td>
                        <td className="px-6 py-4">
                          <div className="font-medium text-gray-900">{item.product?.name || '-'}</div>
                          {item.product?.sku && <div className="text-xs text-gray-500">{item.product.sku}</div>}
                        </td>
                        <td className="px-6 py-4 text-sm text-gray-600">
                          {formatChangeType(item.type)}
                        </td>
                        <td className="px-6 py-4">
                          <span className={`font-medium ${item.quantity >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                            {item.quantity >= 0 ? '+' : ''}{item.quantity}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-sm text-gray-600">
                          {item.previousStock} → {item.newStock}
                        </td>
                        <td className="px-6 py-4 text-sm text-gray-500">
                          {item.reason || '-'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {/* Alerts Tab */}
          {activeTab === 'alerts' && (
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              {alerts.length === 0 ? (
                <div className="p-12 text-center">
                  <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
                    <svg className="w-8 h-8 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                  <h3 className="text-lg font-semibold text-gray-900 mb-2">All Good!</h3>
                  <p className="text-gray-500">No low stock or out of stock products</p>
                </div>
              ) : (
                <table className="w-full">
                  <thead>
                    <tr className="bg-gray-50 border-b border-gray-200">
                      <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Product</th>
                      <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">SKU</th>
                      <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Current Stock</th>
                      <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Threshold</th>
                      <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                      <th className="text-right px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200">
                    {alerts.map((product) => (
                      <tr key={product.id} className="hover:bg-gray-50">
                        <td className="px-6 py-4">
                          <div className="font-medium text-gray-900">{product.name}</div>
                          {product.nameAr && <div className="text-sm text-gray-500 font-arabic">{product.nameAr}</div>}
                        </td>
                        <td className="px-6 py-4 text-sm text-gray-600">
                          {product.sku || '-'}
                        </td>
                        <td className="px-6 py-4">
                          <span className={`font-semibold ${product.inventory <= 0 ? 'text-red-600' : 'text-yellow-600'}`}>
                            {product.inventory}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-sm text-gray-600">
                          {product.lowStockThreshold}
                        </td>
                        <td className="px-6 py-4">
                          <span className={`px-2 py-1 rounded-full text-xs font-medium ${STOCK_STATUS_STYLES[product.stockStatus].bg} ${STOCK_STATUS_STYLES[product.stockStatus].text}`}>
                            {STOCK_STATUS_STYLES[product.stockStatus].label}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-right">
                          <button
                            onClick={() => {
                              setSelectedProduct(product);
                              setShowAdjustModal(true);
                            }}
                            className="px-3 py-1 bg-orange-500 text-white rounded-lg hover:bg-orange-600 text-sm font-medium"
                          >
                            Restock
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </>
      )}

      {/* Adjust Modal */}
      {showAdjustModal && selectedProduct && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md">
            <div className="flex items-center justify-between p-6 border-b border-gray-200">
              <h2 className="text-xl font-semibold text-gray-900">Adjust Inventory</h2>
              <button
                onClick={() => {
                  setShowAdjustModal(false);
                  setSelectedProduct(null);
                }}
                className="p-2 text-gray-400 hover:text-gray-600"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <form onSubmit={handleAdjust} className="p-6 space-y-4">
              <div className="bg-gray-50 rounded-lg p-4">
                <p className="font-medium text-gray-900">{selectedProduct.name}</p>
                <p className="text-sm text-gray-500">Current stock: {selectedProduct.inventory}</p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Adjustment Type
                </label>
                <select
                  value={adjustType}
                  onChange={(e) => setAdjustType(e.target.value)}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                >
                  {ADJUSTMENT_TYPES.map((type) => (
                    <option key={type.value} value={type.value}>{type.label}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Quantity <span className="text-red-500">*</span>
                </label>
                <input
                  type="number"
                  min="1"
                  value={adjustQuantity}
                  onChange={(e) => setAdjustQuantity(e.target.value)}
                  placeholder="Enter quantity"
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                  required
                />
                {adjustQuantity && (
                  <p className="text-sm text-gray-500 mt-1">
                    New stock will be: {' '}
                    <span className="font-medium">
                      {['manual_remove', 'damage'].includes(adjustType)
                        ? Math.max(0, selectedProduct.inventory - parseInt(adjustQuantity || '0'))
                        : selectedProduct.inventory + parseInt(adjustQuantity || '0')
                      }
                    </span>
                  </p>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Reason
                </label>
                <input
                  type="text"
                  value={adjustReason}
                  onChange={(e) => setAdjustReason(e.target.value)}
                  placeholder="Optional reason for adjustment"
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                />
              </div>

              <div className="flex items-center justify-end gap-3 pt-4">
                <button
                  type="button"
                  onClick={() => {
                    setShowAdjustModal(false);
                    setSelectedProduct(null);
                  }}
                  className="px-4 py-2 text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving || !adjustQuantity}
                  className="px-4 py-2 bg-orange-500 text-white rounded-lg hover:bg-orange-600 disabled:opacity-50 flex items-center gap-2"
                >
                  {saving && <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>}
                  Apply
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </AdminLayout>
  );
}
