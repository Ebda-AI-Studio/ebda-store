'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiGet } from './api';

export type ActivationStatus = 'requested' | 'activated' | 'rejected';

/** One store's activation request for a provider (merchant view). */
export interface ActivationRequest {
  id: string;
  provider: string;
  status: ActivationStatus;
  note: string | null;
  requestedAt: string;
  decidedAt: string | null;
}

/** The store's activation requests, and a refetch to call after any write. */
export function useStoreActivations(storeId: string | undefined) {
  const [requests, setRequests] = useState<ActivationRequest[]>([]);

  const refetch = useCallback(async () => {
    if (!storeId) return;
    const { data } = await apiGet<{ requests: ActivationRequest[] }>(
      `/api/v1/provider-activation/store/${storeId}`
    );
    if (data?.requests) setRequests(data.requests);
  }, [storeId]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { requests, refetch };
}
