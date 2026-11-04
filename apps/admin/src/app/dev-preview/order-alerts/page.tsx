import { notFound } from 'next/navigation';
import { OrderAlertsPreview } from './OrderAlertsPreview';

/** Dev-only visual preview of the order-alerts modal. 404s everywhere except `next dev`. */
export default function Page() {
  if (process.env.NODE_ENV !== 'development') notFound();
  return <OrderAlertsPreview />;
}
