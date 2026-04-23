export interface InventoryStats {
  totalProducts: number;
  totalStock: number;
  lowStockCount: number;
  outOfStockCount: number;
  totalValue: number;
}

export type StockStatus = 'in_stock' | 'low_stock' | 'out_of_stock';

export interface ProductInventory {
  id: string;
  name: string;
  nameAr: string | null;
  sku: string | null;
  inventory: number;
  lowStockThreshold: number;
  trackInventory: boolean;
  costPrice: number | null;
  status: string;
  stockStatus: StockStatus;
  stockValue: number;
}

export interface HistoryItem {
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

export type StockFilter = 'all' | StockStatus;
export type InventoryTab = 'products' | 'history' | 'alerts';

export interface AdjustmentType {
  value: string;
  sign: string;
}

export const STOCK_STATUS_STYLES: Record<StockStatus, { bg: string; text: string }> = {
  in_stock: { bg: 'bg-success/10', text: 'text-success' },
  low_stock: { bg: 'bg-warning/10', text: 'text-warning' },
  out_of_stock: { bg: 'bg-destructive/10', text: 'text-destructive' },
};

export const ADJUSTMENT_TYPES: AdjustmentType[] = [
  { value: 'manual_add', sign: '+' },
  { value: 'manual_remove', sign: '-' },
  { value: 'damage', sign: '-' },
  { value: 'adjustment', sign: '±' },
];

export const HISTORY_TYPE_KEYS = [
  'manual_add',
  'manual_remove',
  'sale',
  'return_stock',
  'adjustment',
  'damage',
  'transfer_in',
  'transfer_out',
  'initial',
] as const;
