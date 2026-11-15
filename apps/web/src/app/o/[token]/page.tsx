import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { API_URL } from '../../../lib/api';

/**
 * The guest-safe order summary behind the COD WhatsApp button (Ruling WA-COD-V2-2). Server-rendered and read-only:
 * the API answers only for a valid signed token of THIS store (we forward the request host), anything else is a 404.
 * Shows status, items, total and the delivery area, never a phone, email or street. A signed-in owner has the full
 * page at /account/orders/<id>, linked below.
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Order status | حالة الطلب',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

type Summary = {
  orderNumber: string;
  status: string;
  total: number;
  currency: string;
  locale: 'ar' | 'en';
  area: string | null;
  items: { name: string; variant: string | null; quantity: number }[];
};

const STATUS: Record<string, [string, string]> = {
  pending: ['مستني التأكيد', 'Awaiting confirmation'],
  confirmed: ['اتأكد', 'Confirmed'],
  processing: ['بيتجهّز', 'Being prepared'],
  shipped: ['اتشحن', 'Shipped'],
  delivered: ['اتسلّم', 'Delivered'],
  cancelled: ['اتلغى', 'Cancelled'],
  refunded: ['اتردّ', 'Refunded'],
};

export default async function OrderStatusPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const h = await headers();
  const host = h.get('x-store-domain') ?? h.get('host') ?? '';
  const res = await fetch(`${API_URL}/public/order-status/${encodeURIComponent(token)}`, {
    cache: 'no-store',
    headers: { 'x-store-domain': host },
  }).catch(() => null);
  if (!res || res.status === 404) notFound();
  if (!res.ok) throw new Error('order status unavailable');
  const { data } = (await res.json()) as { data: Summary };
  const ar = data.locale === 'ar';
  const L = (a: string, e: string) => (ar ? a : e);
  const status = STATUS[data.status]?.[ar ? 0 : 1] ?? data.status;
  const total = new Intl.NumberFormat(ar ? 'ar-EG' : 'en-EG', {
    style: 'currency',
    currency: data.currency,
  }).format(data.total / 100);
  return (
    <main dir={ar ? 'rtl' : 'ltr'} className="mx-auto max-w-md px-4 py-10">
      <h1 className="text-xl font-semibold">
        {L('طلب رقم', 'Order')} {data.orderNumber}
      </h1>
      <p className="mt-1 text-sm opacity-80">
        {L('الحالة', 'Status')}: {status}
      </p>
      <ul className="mt-6 divide-y divide-foreground/10 border-y border-foreground/10">
        {data.items.map((i, n) => (
          <li key={n} className="flex justify-between gap-3 py-2 text-sm">
            <span>
              {i.name}
              {i.variant ? ` (${i.variant})` : ''}
            </span>
            <span>× {i.quantity}</span>
          </li>
        ))}
      </ul>
      <dl className="mt-4 space-y-1 text-sm">
        <div className="flex justify-between">
          <dt>{L('الإجمالي', 'Total')}</dt>
          <dd>{total}</dd>
        </div>
        {data.area ? (
          <div className="flex justify-between">
            <dt>{L('منطقة التوصيل', 'Delivery area')}</dt>
            <dd>{data.area}</dd>
          </div>
        ) : null}
      </dl>
      <p className="mt-8 text-xs opacity-70">
        {L('لتفاصيل أكتر سجّل دخولك بحسابك.', 'Sign in to your account for full details.')}
      </p>
    </main>
  );
}
