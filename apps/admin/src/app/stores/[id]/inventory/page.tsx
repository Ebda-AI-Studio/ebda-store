'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { AdminLayout } from '../../../../components/AdminLayout';
import { apiGet, apiPost } from '../../../../lib/api';

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

  const [_storeName, setStoreName] = useState('');
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState<InventoryStats | null>(null);
  const [products, setProducts] = useState<ProductInventory[]>([]);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [alerts, setAlerts] = useState<ProductInventory[]>([]);

  const [activeTab, setActiveTab] = useState<'products' | 'history' | 'alerts'>('products');
  const [stockFilter, setStockFilter] = useState<'all' | 'in_stock' | 'low_stock' | 'out_of_stock'>(
    'all'
  );
  const [search, setSearch] = useState('');

  const [showAdjustModal, setShowAdjustModal] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState<ProductInventory | null>(null);
  const [adjustType, setAdjustType] = useState('manual_add');
  const [adjustQuantity, setAdjustQuantity] = useState('');
  const [adjustReason, setAdjustReason] = useState('');
  const [saving, setSaving] = useState(false);

  const fetchStoreName = useCallback(async () => {
    const { data } = await apiGet<{ store: { name: string } }>(`/api/v1/stores/${storeId}`);
    if (data) {
      setStoreName(data.store?.name || '');
    }
  }, [storeId]);

  const fetchStats = useCallback(async () => {
    const { data } = await apiGet<{ stats: InventoryStats }>(
      `/api/v1/stores/${storeId}/inventory/stats`
    );
    if (data) {
      setStats(data.stats || null);
    }
  }, [storeId]);

  const fetchProducts = useCallback(async () => {
    const params = new URLSearchParams();
    if (stockFilter !== 'all') params.set('stockFilter', stockFilter);
    if (search) params.set('search', search);
    params.set('sortBy', 'inventory');
    params.set('sortOrder', 'asc');

    const { data } = await apiGet<{ products: ProductInventory[] }>(
      `/api/v1/stores/${storeId}/inventory/products?${params}`
    );
    if (data) {
      setProducts(data.products || []);
    }
  }, [storeId, stockFilter, search]);

  const fetchHistory = useCallback(async () => {
    const { data } = await apiGet<{ history: HistoryItem[] }>(
      `/api/v1/stores/${storeId}/inventory/history?limit=50`
    );
    if (data) {
      setHistory(data.history || []);
    }
  }, [storeId]);

  const fetchAlerts = useCallback(async () => {
    const { data } = await apiGet<{ alerts: ProductInventory[] }>(
      `/api/v1/stores/${storeId}/inventory/alerts`
    );
    if (data) {
      setAlerts(data.alerts || []);
    }
  }, [storeId]);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    await Promise.all([
      fetchStoreName(),
      fetchStats(),
      fetchProducts(),
      fetchHistory(),
      fetchAlerts(),
    ]);
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
      let quantity = parseInt(adjustQuantity);

      // Make negative for remove types
      if (['manual_remove', 'damage'].includes(adjustType)) {
        quantity = -Math.abs(quantity);
      }

      const { error } = await apiPost(`/api/v1/stores/${storeId}/inventory/adjust`, {
        productId: selectedProduct.id,
        quantity,
        type: adjustType,
        reason: adjustReason || undefined,
      });

      if (!error) {
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
    <AdminLayout title="Inventory Management" subtitle="Track and manage your product stock levels">
      {loading ? (
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-orange-500"></div>
        </div>
      ) : (
        <>
          {/* Stats Cards */}
          {stats && (
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
              <div className="bg-card rounded-xl border border-border p-4">
                <p className="text-sm text-muted-foreground">Total Products</p>
                <p className="text-2xl font-bold text-foreground">{stats.totalProducts}</p>
              </div>
              <div className="bg-card rounded-xl border border-border p-4">
                <p className="text-sm text-muted-foreground">Total Stock</p>
                <p className="text-2xl font-bold text-blue-600">
                  {stats.totalStock.toLocaleString()}
                </p>
              </div>
              <div className="bg-card rounded-xl border border-border p-4">
                <p className="text-sm text-muted-foreground">Low Stock</p>
                <p className="text-2xl font-bold text-yellow-600">{stats.lowStockCount}</p>
              </div>
              <div className="bg-card rounded-xl border border-border p-4">
                <p className="text-sm text-muted-foreground">Out of Stock</p>
                <p className="text-2xl font-bold text-red-600">{stats.outOfStockCount}</p>
              </div>
              <div className="bg-card rounded-xl border border-border p-4">
                <p className="text-sm text-muted-foreground">Stock Value</p>
                <p className="text-2xl font-bold text-green-600">
                  {(stats.totalValue / 1000).toFixed(3)} KWD
                </p>
              </div>
            </div>
          )}

          {/* Low Stock Alert Banner */}
          {alerts.length > 0 && (
            <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-4 mb-6">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-yellow-100 rounded-full flex items-center justify-center">
                  <svg
                    className="w-5 h-5 text-yellow-600"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                    />
                  </svg>
                </div>
                <div className="flex-1">
                  <p className="font-medium text-yellow-800">
                    {alerts.length} product{alerts.length > 1 ? 's' : ''} need attention
                  </p>
                  <p className="text-sm text-yellow-700">
                    {alerts.filter(a => a.stockStatus === 'out_of_stock').length} out of stock,{' '}
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
                  : 'bg-muted text-foreground hover:bg-muted/80'
              }`}
            >
              Products
            </button>
            <button
              onClick={() => setActiveTab('history')}
              className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                activeTab === 'history'
                  ? 'bg-orange-500 text-white'
                  : 'bg-muted text-foreground hover:bg-muted/80'
              }`}
            >
              History
            </button>
            <button
              onClick={() => setActiveTab('alerts')}
              className={`px-4 py-2 rounded-lg font-medium transition-colors relative ${
                activeTab === 'alerts'
                  ? 'bg-orange-500 text-white'
                  : 'bg-muted text-foreground hover:bg-muted/80'
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
            <div className="bg-card rounded-xl border border-border overflow-hidden">
              {/* Filters */}
              <div className="flex flex-wrap gap-4 p-4 bg-muted border-b border-border">
                <div className="flex-1 min-w-[200px]">
                  <input
                    type="text"
                    placeholder="Search products..."
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                  />
                </div>
                <div className="flex gap-2">
                  {(['all', 'in_stock', 'low_stock', 'out_of_stock'] as const).map(filter => (
                    <button
                      key={filter}
                      onClick={() => setStockFilter(filter)}
                      className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                        stockFilter === filter
                          ? 'bg-orange-500 text-white'
                          : 'bg-card text-foreground hover:bg-muted border border-border'
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
                  <p className="text-muted-foreground">No products found</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="bg-muted border-b border-border">
                        <th className="text-left px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                          Product
                        </th>
                        <th className="text-left px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                          SKU
                        </th>
                        <th className="text-left px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                          Stock
                        </th>
                        <th className="text-left px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                          Threshold
                        </th>
                        <th className="text-left px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                          Status
                        </th>
                        <th className="text-left px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                          Value
                        </th>
                        <th className="text-right px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                          Actions
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {products.map(product => (
                        <tr key={product.id} className="hover:bg-muted">
                          <td className="px-6 py-4">
                            <div>
                              <div className="font-medium text-foreground">{product.name}</div>
                              {product.nameAr && (
                                <div className="text-sm text-muted-foreground font-arabic">
                                  {product.nameAr}
                                </div>
                              )}
                            </div>
                          </td>
                          <td className="px-6 py-4 text-sm text-muted-foreground">
                            {product.sku || '-'}
                          </td>
                          <td className="px-6 py-4">
                            <span className="font-semibold text-foreground">
                              {product.inventory}
                            </span>
                          </td>
                          <td className="px-6 py-4 text-sm text-muted-foreground">
                            {product.lowStockThreshold}
                          </td>
                          <td className="px-6 py-4">
                            <span
                              className={`px-2 py-1 rounded-full text-xs font-medium ${STOCK_STATUS_STYLES[product.stockStatus].bg} ${STOCK_STATUS_STYLES[product.stockStatus].text}`}
                            >
                              {STOCK_STATUS_STYLES[product.stockStatus].label}
                            </span>
                          </td>
                          <td className="px-6 py-4 text-sm text-muted-foreground">
                            {product.costPrice
                              ? `${(product.stockValue / 1000).toFixed(3)} KWD`
                              : '-'}
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
                </div>
              )}
            </div>
          )}

          {/* History Tab */}
          {activeTab === 'history' && (
            <div className="bg-card rounded-xl border border-border overflow-hidden">
              {history.length === 0 ? (
                <div className="p-12 text-center">
                  <p className="text-muted-foreground">No inventory history yet</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="bg-muted border-b border-border">
                        <th className="text-left px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                          Date
                        </th>
                        <th className="text-left px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                          Product
                        </th>
                        <th className="text-left px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                          Type
                        </th>
                        <th className="text-left px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                          Change
                        </th>
                        <th className="text-left px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                          Stock
                        </th>
                        <th className="text-left px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                          Reason
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {history.map(item => (
                        <tr key={item.id} className="hover:bg-muted">
                          <td className="px-6 py-4 text-sm text-muted-foreground">
                            {new Date(item.createdAt).toLocaleDateString('en-US', {
                              month: 'short',
                              day: 'numeric',
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </td>
                          <td className="px-6 py-4">
                            <div className="font-medium text-foreground">
                              {item.product?.name || '-'}
                            </div>
                            {item.product?.sku && (
                              <div className="text-xs text-muted-foreground">
                                {item.product.sku}
                              </div>
                            )}
                          </td>
                          <td className="px-6 py-4 text-sm text-muted-foreground">
                            {formatChangeType(item.type)}
                          </td>
                          <td className="px-6 py-4">
                            <span
                              className={`font-medium ${item.quantity >= 0 ? 'text-green-600' : 'text-red-600'}`}
                            >
                              {item.quantity >= 0 ? '+' : ''}
                              {item.quantity}
                            </span>
                          </td>
                          <td className="px-6 py-4 text-sm text-muted-foreground">
                            {item.previousStock} → {item.newStock}
                          </td>
                          <td className="px-6 py-4 text-sm text-muted-foreground">
                            {item.reason || '-'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* Alerts Tab */}
          {activeTab === 'alerts' && (
            <div className="bg-card rounded-xl border border-border overflow-hidden">
              {alerts.length === 0 ? (
                <div className="p-12 text-center">
                  <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
                    <svg
                      className="w-8 h-8 text-green-600"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M5 13l4 4L19 7"
                      />
                    </svg>
                  </div>
                  <h3 className="text-lg font-semibold text-foreground mb-2">All Good!</h3>
                  <p className="text-muted-foreground">No low stock or out of stock products</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="bg-muted border-b border-border">
                        <th className="text-left px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                          Product
                        </th>
                        <th className="text-left px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                          SKU
                        </th>
                        <th className="text-left px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                          Current Stock
                        </th>
                        <th className="text-left px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                          Threshold
                        </th>
                        <th className="text-left px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                          Status
                        </th>
                        <th className="text-right px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                          Actions
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {alerts.map(product => (
                        <tr key={product.id} className="hover:bg-muted">
                          <td className="px-6 py-4">
                            <div className="font-medium text-foreground">{product.name}</div>
                            {product.nameAr && (
                              <div className="text-sm text-muted-foreground font-arabic">
                                {product.nameAr}
                              </div>
                            )}
                          </td>
                          <td className="px-6 py-4 text-sm text-muted-foreground">
                            {product.sku || '-'}
                          </td>
                          <td className="px-6 py-4">
                            <span
                              className={`font-semibold ${product.inventory <= 0 ? 'text-red-600' : 'text-yellow-600'}`}
                            >
                              {product.inventory}
                            </span>
                          </td>
                          <td className="px-6 py-4 text-sm text-muted-foreground">
                            {product.lowStockThreshold}
                          </td>
                          <td className="px-6 py-4">
                            <span
                              className={`px-2 py-1 rounded-full text-xs font-medium ${STOCK_STATUS_STYLES[product.stockStatus].bg} ${STOCK_STATUS_STYLES[product.stockStatus].text}`}
                            >
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
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* Adjust Modal */}
      {showAdjustModal && selectedProduct && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-card rounded-xl shadow-xl w-full max-w-md">
            <div className="flex items-center justify-between p-6 border-b border-border">
              <h2 className="text-xl font-semibold text-foreground">Adjust Inventory</h2>
              <button
                onClick={() => {
                  setShowAdjustModal(false);
                  setSelectedProduct(null);
                }}
                className="p-2 text-muted-foreground hover:text-foreground"
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

            <form onSubmit={handleAdjust} className="p-6 space-y-4">
              <div className="bg-muted rounded-lg p-4">
                <p className="font-medium text-foreground">{selectedProduct.name}</p>
                <p className="text-sm text-muted-foreground">
                  Current stock: {selectedProduct.inventory}
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-foreground mb-2">
                  Adjustment Type
                </label>
                <select
                  value={adjustType}
                  onChange={e => setAdjustType(e.target.value)}
                  className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                >
                  {ADJUSTMENT_TYPES.map(type => (
                    <option key={type.value} value={type.value}>
                      {type.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-foreground mb-2">
                  Quantity <span className="text-red-500">*</span>
                </label>
                <input
                  type="number"
                  min="1"
                  value={adjustQuantity}
                  onChange={e => setAdjustQuantity(e.target.value)}
                  placeholder="Enter quantity"
                  className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                  required
                />
                {adjustQuantity && (
                  <p className="text-sm text-muted-foreground mt-1">
                    New stock will be:{' '}
                    <span className="font-medium">
                      {['manual_remove', 'damage'].includes(adjustType)
                        ? Math.max(0, selectedProduct.inventory - parseInt(adjustQuantity || '0'))
                        : selectedProduct.inventory + parseInt(adjustQuantity || '0')}
                    </span>
                  </p>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-foreground mb-2">Reason</label>
                <input
                  type="text"
                  value={adjustReason}
                  onChange={e => setAdjustReason(e.target.value)}
                  placeholder="Optional reason for adjustment"
                  className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                />
              </div>

              <div className="flex items-center justify-end gap-3 pt-4">
                <button
                  type="button"
                  onClick={() => {
                    setShowAdjustModal(false);
                    setSelectedProduct(null);
                  }}
                  className="px-4 py-2 text-foreground border border-border rounded-lg hover:bg-muted"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving || !adjustQuantity}
                  className="px-4 py-2 bg-orange-500 text-white rounded-lg hover:bg-orange-600 disabled:opacity-50 flex items-center gap-2"
                >
                  {saving && (
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                  )}
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
