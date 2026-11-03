'use client';

import { useState } from 'react';
import { OrderAlertsModal } from '../../../components/OrderAlertsModal';

export function OrderAlertsPreview() {
  const [open, setOpen] = useState(true);
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="m-6 underline">
        reopen
      </button>
    );
  }
  return <OrderAlertsModal onEnable={() => setOpen(false)} onLater={() => setOpen(false)} />;
}
