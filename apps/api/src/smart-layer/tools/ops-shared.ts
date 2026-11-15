/** Small helpers the three ops tool files share (E2). */
import type { PreviewRow } from '@ebda/shared/smart-layer';
import { AppError } from '../../middleware/error-handler';

export type Rec = Record<string, unknown>;
/** The routes' `authorize('store_admin', 'super_admin')`: a super admin never acts through the assistant. */
export const OWNER = ['store_admin'] as const;
export const OWNER_OR_STAFF = ['store_admin', 'staff'] as const;
/** A card row whose text came from a shopper or applicant. */
export const untrusted = (r: PreviewRow): PreviewRow => ({ ...r, source: 'untrusted' });
/** A decimal EGP amount typed by the merchant, as integer piasters. */
export const toPiasters = (egpValue: number): number => Math.round(egpValue * 100);
export const notFound = (what: string): AppError =>
  new AppError(404, 'NOT_FOUND', `${what} not found`);
export const iso = (d: unknown): string | null => (d ? new Date(d as string).toISOString() : null);
