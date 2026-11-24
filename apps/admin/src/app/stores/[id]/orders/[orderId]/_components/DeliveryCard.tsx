'use client';

import { useT } from '@/i18n/useT';
import { useLocale } from 'next-intl';
import { formatAddressLines, formatDateTime, type AddressLabels } from './format';
import type { OrderDetail } from './types';
import { useMessageCustomerHref } from './useMessageCustomer';

import { Button, buttonVariants } from '@/components/ui/Button';
interface DeliveryCardProps {
  order: OrderDetail;
  locale: string;
  onEdit?: () => void;
}

export function DeliveryCard({ order, locale, onEdit }: DeliveryCardProps) {
  const t = useT('orders.detail');
  const currentLocale = useLocale();
  const isRtl = currentLocale === 'ar';

  // Build locale-aware labels for address field prefixes (قطعة / Block, etc.)
  const addressLabels: AddressLabels = {
    block: t('address.block'),
    street: t('address.street'),
    avenue: t('address.avenue'),
    house: t('address.house'),
    building: t('address.building'),
    floor: t('address.floor'),
    apt: t('address.apt'),
  };

  const lines = formatAddressLines(order.shippingAddress, addressLabels, currentLocale);

  // Pull recipient details from the shipping address first (this is who
  // physically receives the package — the customer record is a fallback
  // for guest orders or where the shipping address omitted them).
  const ship = order.shippingAddress;
  const recipientName =
    [ship?.firstName, ship?.lastName].filter(Boolean).join(' ').trim() ||
    [order.customer?.firstName, order.customer?.lastName].filter(Boolean).join(' ').trim();
  const recipientPhone = ship?.phone || order.customer?.phone || '';
  const recipientEmail = ship?.email || order.customer?.email || '';
  const deliveryNotes = ship?.notes?.trim() || order.customerNotes?.trim() || '';

  const phoneDigits = recipientPhone.replace(/\D/g, '');
  const callHref = phoneDigits ? `tel:${phoneDigits}` : null;
  const waHref = useMessageCustomerHref(order, recipientPhone, recipientName);
  const mailHref = recipientEmail ? `mailto:${recipientEmail}` : null;

  return (
    <section className="rounded-lg border border-border bg-card p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
          {t('delivery')}
        </h2>
        {onEdit && (
          <Button type="button" onClick={onEdit} variant="link" className="gap-1.5">
            <svg
              className="h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              aria-hidden
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
              />
            </svg>
            {t('editDeliveryStatus')}
          </Button>
        )}
      </div>

      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary-ink">
          <svg
            className="h-5 w-5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            aria-hidden
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 17a2 2 0 11-4 0 2 2 0 014 0zM19 17a2 2 0 11-4 0 2 2 0 014 0z"
            />
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M13 16V6a1 1 0 00-1-1H4a1 1 0 00-1 1v10a1 1 0 001 1h1m8-1a1 1 0 01-1 1H9m4-1V8a1 1 0 011-1h2.586a1 1 0 01.707.293l3.414 3.414a1 1 0 01.293.707V16a1 1 0 01-1 1h-1m-6-1a1 1 0 001 1h1M5 17a2 2 0 104 0m-4 0a2 2 0 114 0m6 0a2 2 0 104 0m-4 0a2 2 0 114 0"
            />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          {recipientName && (
            <div className="font-semibold text-foreground mb-2 truncate">{recipientName}</div>
          )}

          {(recipientPhone || recipientEmail) && (
            <dl className="space-y-1.5 text-sm mb-3">
              {recipientPhone && (
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-muted-foreground shrink-0">{t('phone')}</dt>
                  <dd className="font-medium text-foreground truncate" dir="ltr">
                    {recipientPhone}
                  </dd>
                </div>
              )}
              {recipientEmail && (
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-muted-foreground shrink-0">{t('email')}</dt>
                  <dd className="font-medium text-foreground truncate" dir="ltr">
                    {recipientEmail}
                  </dd>
                </div>
              )}
            </dl>
          )}

          {(callHref || waHref || mailHref) && (
            <div className="grid grid-cols-3 gap-2 mb-4">
              {callHref && (
                <a
                  href={callHref}
                  className={buttonVariants({
                    variant: 'outline',
                    className: 'justify-center gap-2',
                  })}
                >
                  <svg
                    className="h-4 w-4"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    aria-hidden
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z"
                    />
                  </svg>
                  <span className="hidden sm:inline">{t('callCustomer')}</span>
                </a>
              )}
              {waHref && (
                <a
                  href={waHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={buttonVariants({
                    variant: 'outline',
                    className: 'justify-center gap-2',
                  })}
                >
                  <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24" aria-hidden>
                    <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.71.306 1.263.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
                  </svg>
                  <span className="hidden sm:inline">{t('whatsappCustomer')}</span>
                </a>
              )}
              {mailHref && (
                <a
                  href={mailHref}
                  className={buttonVariants({
                    variant: 'outline',
                    className: 'justify-center gap-2',
                  })}
                >
                  <svg
                    className="h-4 w-4"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    aria-hidden
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
                    />
                  </svg>
                  <span className="hidden sm:inline">{t('email')}</span>
                </a>
              )}
            </div>
          )}

          {lines.length > 0 ? (
            <>
              <div className="text-sm text-muted-foreground mb-1">{t('deliverTo')}:</div>
              <div className="text-sm text-foreground space-y-0.5" dir={isRtl ? 'rtl' : 'ltr'}>
                {lines.map((line, i) => (
                  <div key={i}>{line}</div>
                ))}
              </div>
            </>
          ) : (
            <div className="text-sm text-muted-foreground">—</div>
          )}

          {deliveryNotes && (
            <div className="mt-4 rounded-lg border border-warning/30 bg-warning/10 p-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-warning-ink mb-1">
                {t('customerNotes')}
              </div>
              <div className="text-sm text-foreground whitespace-pre-wrap break-words">
                {deliveryNotes}
              </div>
            </div>
          )}

          {/* QA-D3: this card used to print a hard-coded "self delivery" and the ORDER time as the delivery
              time. The carrier is on the shipment card; the time shown is the real delivery time, or nothing. */}
          {order.deliveredAt && (
            <dl className="mt-4 space-y-2 text-sm">
              <div className="flex gap-2">
                <dt className="text-muted-foreground shrink-0">{t('deliverAt')}:</dt>
                <dd className="text-foreground font-medium">
                  {formatDateTime(order.deliveredAt, locale)}
                </dd>
              </div>
            </dl>
          )}
        </div>
      </div>
    </section>
  );
}
