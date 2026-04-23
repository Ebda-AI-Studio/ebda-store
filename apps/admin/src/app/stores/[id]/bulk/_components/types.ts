export interface ImportResult {
  total: number;
  created: number;
  updated: number;
  failed: number;
  errors: Array<{ row: number; error: string }>;
}

export type BulkTab = 'import' | 'export';
export type FileKind = 'csv' | 'xlsx';
export type DefaultStatus = 'draft' | 'active';

export interface ExportFilters {
  status: string;
  search: string;
  includeDeleted: boolean;
}

export interface ImportOptions {
  updateExisting: boolean;
  skuPrefix: string;
  defaultInventory: number;
  defaultStatus: DefaultStatus;
  trackInventory: boolean;
}
