import { apiFetch, apiGet, apiPatch, apiPost, apiDelete } from '../../../../../../lib/api';
import { postMultipart } from '../../../../../../components/instapay/api';
import { confidenceBand, BLOCKING_FLAGS } from '@ebda/shared';

export { confidenceBand, BLOCKING_FLAGS };

export interface JobSummary {
  id: string;
  status: 'queued' | 'processing' | 'review' | 'creating' | 'done' | 'failed' | 'cancelled';
  errorCode: string | null;
  filesTotal: number;
  filesDone: number;
  filesFailed: number;
  pagesTotal: number;
  itemsTotal: number;
  draftsCreated: number;
  createdAt: string;
}
export interface Allowance {
  monthlyLimit: number | null;
  remainingMonth: number | null;
  remainingToday: number;
  enabled: boolean;
}
export interface JobFile {
  id: string;
  mime: string;
  originalName: string;
  pageCount: number;
  status: 'stored' | 'processing' | 'done' | 'failed' | 'skipped_quota';
  errorCode: string | null;
  itemsFound: number;
}
export interface JobDetail extends JobSummary {
  files: JobFile[];
  itemCounts: Record<string, number>;
}
export interface VariantRow {
  options: Record<string, string>;
  priceMinor: number | null;
  sku?: string | null;
}
export interface ReviewItem {
  id: string;
  fileId: string;
  status: 'pending' | 'accepted' | 'rejected' | 'created' | 'failed';
  name: string | null;
  nameAr: string | null;
  description: string | null;
  descriptionAr: string | null;
  priceMinor: number | null;
  compareAtMinor: number | null;
  sku: string | null;
  categoryName: string | null;
  categoryId: string | null;
  tags: string[];
  variants: VariantRow[];
  confidence: number;
  flags: string[];
  acknowledged: string[];
  sourceText: string | null;
  editedFields: string[];
  productId: string | null;
  createErrorCode: string | null;
}

const base = (storeId: string) => `/api/v1/stores/${storeId}/catalog-import`;

export const listJobs = (storeId: string) =>
  apiGet<{ jobs: JobSummary[]; allowance: Allowance }>(base(storeId));
export const getJob = (storeId: string, jobId: string) =>
  apiGet<JobDetail>(`${base(storeId)}/${jobId}`);
export const listItems = (storeId: string, jobId: string, status: string) =>
  apiGet<{ items: ReviewItem[]; nextCursor: string | null }>(
    `${base(storeId)}/${jobId}/items?status=${status}&limit=100`
  );
export const patchItem = (storeId: string, jobId: string, itemId: string, body: object) =>
  apiPatch<ReviewItem>(`${base(storeId)}/${jobId}/items/${itemId}`, body);
export const bulkAccept = (storeId: string, jobId: string) =>
  apiPost<{ accepted: number }>(`${base(storeId)}/${jobId}/items/bulk-accept`);
export const createDrafts = (storeId: string, jobId: string) =>
  apiPost<{ queued: number }>(`${base(storeId)}/${jobId}/create-drafts`, {});
export const publish = (storeId: string, jobId: string, itemIds: string[]) =>
  apiPost<{
    published: number;
    refused: Array<{ itemId: string; code: string }>;
    warnings: Array<{ itemId: string; code: string }>;
  }>(`${base(storeId)}/${jobId}/publish`, { itemIds });
export const retryFile = (storeId: string, jobId: string, fileId: string) =>
  apiPost(`${base(storeId)}/${jobId}/files/${fileId}/retry`);
export const cancelJob = (storeId: string, jobId: string) =>
  apiPost(`${base(storeId)}/${jobId}/cancel`);
export const deleteJob = (storeId: string, jobId: string) => apiDelete(`${base(storeId)}/${jobId}`);
export const uploadFiles = (storeId: string, files: File[]) => {
  const form = new FormData();
  for (const f of files) form.append('files', f);
  return postMultipart<{ jobId: string }>(base(storeId), form);
};

/** Open the original (private, tenant-checked) in a new tab through an object URL held only in this browser. */
export async function openSource(storeId: string, jobId: string, fileId: string) {
  const res = await apiFetch(`${base(storeId)}/${jobId}/files/${fileId}/source`);
  if (!res.ok) return false;
  const url = URL.createObjectURL(await res.blob());
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return true;
}

/** "150.5" -> 15050 piastres; empty -> null; garbage -> undefined (leave the field alone). */
export function egpToMinor(input: string): number | null | undefined {
  const s = input
    .trim()
    .replace(/[\u0660-\u0669]/g, d => String(d.charCodeAt(0) - 0x0660))
    .replace('٫', '.');
  if (s === '') return null;
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return undefined;
  return Math.round(Number(s) * 100);
}
export const minorToEgp = (m: number | null): string => (m === null ? '' : String(m / 100));
