import { useEffect, useState } from 'react';
import { apiGet } from '../../../../../lib/api';

interface PushStatus {
  /** null while loading; false = push is not set up on our side yet (never a merchant task). */
  available: boolean | null;
  subscribers: number;
}

/** One plain answer to "can this store send push right now?" for the notifications page. */
export function usePushStatus(storeId: string): PushStatus {
  const [status, setStatus] = useState<PushStatus>({ available: null, subscribers: 0 });
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await apiGet<{ available: boolean; subscribers: number }>(
        `/api/v1/admin/stores/${storeId}/push/status`
      );
      if (cancelled) return;
      // A failed probe is "not available yet" (the composer stays off), never an error wall.
      setStatus(
        error || !data
          ? { available: false, subscribers: 0 }
          : { available: data.available === true, subscribers: data.subscribers ?? 0 }
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [storeId]);
  return status;
}
