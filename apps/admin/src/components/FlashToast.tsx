'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { useToast } from '@ebda/ui';
import { takeFlashToast } from '@/lib/flash-toast';

/** Shows the success message a page queued before redirecting (see lib/flash-toast.ts). */
export function FlashToast() {
  const pathname = usePathname();
  const toast = useToast();
  useEffect(() => {
    const title = takeFlashToast();
    if (title) toast.success(title);
    // toast is a new object every provider render; the route change is the only trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);
  return null;
}
