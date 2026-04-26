'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { useT } from '@/i18n/useT';
import { AdminLayout } from '../../../../components/AdminLayout';
import { apiPost } from '../../../../lib/api';
import { AdjustStockModal } from './_components/AdjustStockModal';
import { InventoryStatsCards } from './_components/InventoryStatsCards';
import { InventoryTabs } from './_components/InventoryTabs';
import { LowStockAlertBanner } from './_components/LowStockAlertBanner';
import { LowStockAlerts } from './_components/LowStockAlerts';
import { StockLevelsTable } from './_components/StockLevelsTable';
import { StockMovementLog } from './_components/StockMovementLog';
import type { InventoryTab, ProductInventory } from './_components/types';
import { useInventory } from './_hooks/useInventory';
import { useRequireFeature } from '../../../../hooks/useRequireFeature';

const REMOVE_ADJUSTMENT_TYPES = ['manual_remove', 'damage'];

export default function InventoryPage() {
  // Hide this page when the super_admin disabled the inventory feature for
  // this store. The hook redirects to the store dashboard if disabled.
  useRequireFeature('inventory');

  const params = useParams();
  const storeId = params.id as string;
  const tPage = useT('inventory.page');

  const {
    loading,
    stats,
    products,
    history,
    alerts,
    stockFilter,
    setStockFilter,
    search,
    setSearch,
    fetchStats,
    fetchProducts,
    fetchHistory,
    fetchAlerts,
  } = useInventory(storeId);

  const [activeTab, setActiveTab] = useState<InventoryTab>('products');

  const [showAdjustModal, setShowAdjustModal] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState<ProductInventory | null>(null);
  const [adjustType, setAdjustType] = useState('manual_add');
  const [adjustQuantity, setAdjustQuantity] = useState('');
  const [adjustReason, setAdjustReason] = useState('');
  const [saving, setSaving] = useState(false);

  const openAdjustModal = (product: ProductInventory) => {
    setSelectedProduct(product);
    setShowAdjustModal(true);
  };

  const closeAdjustModal = () => {
    setShowAdjustModal(false);
    setSelectedProduct(null);
    setAdjustQuantity('');
    setAdjustReason('');
    setAdjustType('manual_add');
  };

  const handleAdjust = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedProduct) return;

    setSaving(true);
    try {
      let quantity = parseInt(adjustQuantity);

      // Flip sign for destructive adjustments so the API records a negative delta.
      if (REMOVE_ADJUSTMENT_TYPES.includes(adjustType)) {
        quantity = -Math.abs(quantity);
      }

      const { error } = await apiPost(`/api/v1/stores/${storeId}/inventory/adjust`, {
        productId: selectedProduct.id,
        quantity,
        type: adjustType,
        reason: adjustReason || undefined,
      });

      if (!error) {
        closeAdjustModal();
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

  return (
    <AdminLayout title={tPage('title')} subtitle={tPage('subtitle')}>
      {loading ? (
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
        </div>
      ) : (
        <>
          {stats && <InventoryStatsCards stats={stats} />}

          {alerts.length > 0 && (
            <LowStockAlertBanner alerts={alerts} onViewAlerts={() => setActiveTab('alerts')} />
          )}

          <InventoryTabs
            activeTab={activeTab}
            alertsCount={alerts.length}
            onTabChange={setActiveTab}
          />

          {activeTab === 'products' && (
            <StockLevelsTable
              products={products}
              search={search}
              stockFilter={stockFilter}
              onSearchChange={setSearch}
              onFilterChange={setStockFilter}
              onAdjust={openAdjustModal}
            />
          )}

          {activeTab === 'history' && <StockMovementLog history={history} />}

          {activeTab === 'alerts' && <LowStockAlerts alerts={alerts} onAdjust={openAdjustModal} />}
        </>
      )}

      {showAdjustModal && selectedProduct && (
        <AdjustStockModal
          product={selectedProduct}
          adjustType={adjustType}
          adjustQuantity={adjustQuantity}
          adjustReason={adjustReason}
          saving={saving}
          onTypeChange={setAdjustType}
          onQuantityChange={setAdjustQuantity}
          onReasonChange={setAdjustReason}
          onClose={closeAdjustModal}
          onSubmit={handleAdjust}
        />
      )}
    </AdminLayout>
  );
}
