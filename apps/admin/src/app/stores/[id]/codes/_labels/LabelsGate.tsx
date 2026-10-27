'use client';

import { useRequireFeature } from '../../../../../hooks/useRequireFeature';
import { LabelsTab } from './LabelsTab';

/** Product labels are the `inventory.barcode` feature; the QR and receipt tabs are not gated. */
export function LabelsGate({ storeId }: { storeId: string }) {
  const { gate } = useRequireFeature('inventory.barcode');
  return gate ?? <LabelsTab storeId={storeId} />;
}
