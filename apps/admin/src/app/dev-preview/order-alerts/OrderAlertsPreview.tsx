'use client';

import { useState } from 'react';
import { OrderAlertsModal } from '../../../components/OrderAlertsModal';

/** Reload the page to see the modal again. */
export function OrderAlertsPreview() {
  const [open, setOpen] = useState(true);
  if (!open) return null;
  return <OrderAlertsModal onEnable={() => setOpen(false)} onLater={() => setOpen(false)} />;
}
