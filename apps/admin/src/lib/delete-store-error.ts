import type { ApiError } from './api';

export type DeleteStoreErrorKey =
  | 'errBillingParent'
  | 'errMoneyInFlight'
  | 'errMfaRequired'
  | 'errSession'
  | 'errNetwork'
  | null;

/**
 * Which dedicated message (if any) a failed DELETE /stores/:id gets. `null` = use the already-localized
 * `error.message` that `apiRequest` produced (ERROR_AR / details.messageAr). Never raw API text.
 */
export function deleteStoreErrorKey(error: Pick<ApiError, 'code' | 'status'>): DeleteStoreErrorKey {
  if (error.code === 'STORE_IS_BILLING_PARENT') return 'errBillingParent';
  if (error.code === 'STORE_HAS_MONEY_IN_FLIGHT') return 'errMoneyInFlight';
  if (error.status === 403 && error.code === 'MFA_SETUP_REQUIRED') return 'errMfaRequired';
  if (error.status === 401) return 'errSession';
  if (error.status === 0 || error.code === 'NETWORK_ERROR') return 'errNetwork';
  return null;
}
