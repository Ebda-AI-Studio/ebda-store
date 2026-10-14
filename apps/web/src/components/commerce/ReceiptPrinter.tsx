'use client';

/**
 * Order confirmation as a receipt printer (B0 Task 10, every template).
 *
 * A printer card (store tokens: foreground body, background ink) shows the
 * order and a status line; under its slot a white thermal receipt feeds DOWN,
 * torn edge and barcode first, clipped at the slot. When the feed ends the
 * spinner becomes the order's REAL payment state. The status copy and the
 * total label come only from `paymentState`: a COD / awaiting / pending order
 * never reads "paid" (review focus #7).
 *
 * Motion: one CSS transform keyframe (1600ms ease-out-quint, 250ms after the
 * order loads), once per order per tab (sessionStorage), none at all under
 * prefers-reduced-motion. The paper keeps its full height in the layout during
 * the feed, so nothing below jumps when it ends; the receipt is real text the
 * whole time, so screen readers never wait for the animation.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { groupOrderLinesForDisplay, orderTaxPlacement } from '@ebda/shared';
import type { Order } from '@/lib/api';
import type { StoreData } from '@/contexts/StoreContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { useLocalePrice } from '@/hooks/useLocalePrice';
import { useNumerals } from '@/hooks/useNumerals';
import { formatDate } from '@/lib/format-date';
import { paymentMethodLabel, paymentProviderLabel } from '@/lib/order-labels';
import { pickLocalizedName } from '@/templates/shared/display-helpers';
import { CartLineNote } from './CartLineNote';
import { Barcode } from './Barcode';
import styles from './ReceiptPrinter.module.css';

/** The success page's verified payment outcome (SuccessClient owns it). */
export type PaymentState =
  | 'verifying'
  | 'paid'
  | 'pending'
  | 'failed'
  | 'cod'
  | 'awaiting'
  | 'unknown';

type ReceiptStore = Pick<StoreData, 'name' | 'nameAr' | 'logo' | 'logoAr' | 'timezone' | 'theme'>;

export interface ReceiptPrinterProps {
  order: Order | null;
  paymentState: PaymentState;
  store: ReceiptStore;
  /** The order is still being fetched: printer + spinner + empty slot. */
  loading?: boolean;
}

const REDUCED = '(prefers-reduced-motion: reduce)';
/** Mirror the `.feeding` animation in ReceiptPrinter.module.css. */
const FEED_DELAY_MS = 250;
const FEED_MS = 1600;
const printedKey = (orderId: string) => `receipt-printed:${orderId}`;

/** Feed only on the first view of this order in this tab, and never under reduced motion. */
function shouldFeed(orderId: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (window.matchMedia?.(REDUCED).matches) return false;
  } catch {
    /* no matchMedia: feed */
  }
  try {
    return window.sessionStorage.getItem(printedKey(orderId)) === null;
  } catch {
    return true;
  }
}

type StatusKind = 'printing' | PaymentState;

export function ReceiptPrinter({
  order,
  paymentState,
  store,
  loading = false,
}: ReceiptPrinterProps) {
  const { t, language, isRtl } = useLanguage();
  const formatPrice = useLocalePrice();
  const { localize, numerals } = useNumerals();

  // Decided ONCE per order id, before the first paint that shows the paper:
  // deciding in an effect would flash the finished receipt, then snap it up.
  const decision = useRef<{ id: string; feed: boolean } | null>(null);
  if (order && decision.current?.id !== order.id) {
    decision.current = { id: order.id, feed: shouldFeed(order.id) };
  }
  const feed = !!order && decision.current?.feed === true;
  const [fedId, setFedId] = useState<string | null>(null);
  const feedDone = !feed || fedId === order?.id;

  useEffect(() => {
    if (!order || !feed) return;
    try {
      window.sessionStorage.setItem(printedKey(order.id), '1');
    } catch {
      /* storage blocked: the receipt simply prints again next time */
    }
    // Backstop: if `animationend` never arrives (animation cancelled or
    // suppressed), the status must not stay on "printing" forever.
    const id = order.id;
    const timer = window.setTimeout(() => setFedId(id), FEED_DELAY_MS + FEED_MS + 400);
    return () => window.clearTimeout(timer);
  }, [order, feed]);

  const status: StatusKind = loading || (order && !feedDone) ? 'printing' : paymentState;
  const copy = statusCopy(status, t);

  const storeName = (language === 'ar' && store.nameAr?.trim() ? store.nameAr : store.name) || '';
  const logo = language === 'ar' && store.logoAr ? store.logoAr : store.logo;
  const rows = order ? groupOrderLinesForDisplay(order.items) : [];
  // A bundle box counts once, as the customer bought it.
  const itemCount = rows.reduce(
    (n, r) => n + (r.kind === 'bundle' ? r.quantity : r.item.quantity),
    0
  );
  const paid = paymentState === 'paid';

  return (
    <section
      className="mx-auto mt-8 w-full max-w-[24rem] text-start"
      aria-label={t('Order receipt', 'فاتورة الطلب')}
    >
      {/* Printer */}
      <div className={`${styles.housing} relative z-10 p-1.5 shadow-lg`}>
        <div className={`${styles.screen} px-4 pb-3.5 pt-4`}>
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">
                {order ? (
                  <>
                    {t('Order', 'طلب')}{' '}
                    <span className={styles.mono} dir="ltr">
                      #{order.orderNumber}
                    </span>
                  </>
                ) : (
                  t('Your order', 'طلبك')
                )}
              </p>
              <p className="mt-0.5 truncate text-xs opacity-60">
                {order
                  ? t(
                      `${itemCount} ${itemCount === 1 ? 'item' : 'items'}`,
                      arabicPieces(itemCount, localize)
                    )
                  : storeName}
              </p>
            </div>
            {order && (
              <div className="shrink-0 text-end">
                <p className="text-[11px] opacity-60">{t('Order total', 'إجمالي الطلب')}</p>
                <p className={`${styles.mono} text-base font-semibold`}>
                  {formatPrice(order.total)}
                </p>
              </div>
            )}
          </div>
          <div
            className="mt-3 flex min-h-5 items-center gap-2 text-xs"
            aria-live="polite"
            role="status"
          >
            <span key={status} className={`${styles.statusIn} flex items-center gap-2`}>
              <StatusIcon kind={status} />
              <span>{copy}</span>
            </span>
          </div>
        </div>
        <div className={`${styles.slit} mx-2.5 mb-0.5 mt-2 h-1.5 rounded-full`} />
      </div>

      {/* Paper. While the order loads the slot is empty but holds a typical
          receipt's height, so the page does not jump when it arrives. */}
      <div
        className={`${styles.window} mx-4 sm:mx-5 ${order ? '' : loading ? 'min-h-[26rem]' : ''}`}
      >
        {order && (
          <div
            className={`${styles.feeder} ${feed && !feedDone ? styles.feeding : ''}`}
            data-feeding={feed && !feedDone ? 'true' : undefined}
            data-testid="receipt-paper"
            onAnimationEnd={e => {
              if (e.target === e.currentTarget) setFedId(order.id);
            }}
          >
            <article className={`${styles.paper} px-5 pt-6 text-[13px] leading-snug`}>
              <h2 className="flex justify-center">
                {logo ? (
                  <img
                    src={logo}
                    alt={storeName}
                    className="h-9 w-auto max-w-[60%] object-contain"
                  />
                ) : (
                  <span className="font-display text-lg font-semibold">{storeName}</span>
                )}
              </h2>

              <hr className={`${styles.rule} my-4 border-0`} />

              <ul className="space-y-3">
                {rows.map(row => {
                  const qty = row.kind === 'bundle' ? row.quantity : row.item.quantity;
                  const name =
                    row.kind === 'bundle'
                      ? language === 'ar' && row.nameAr?.trim()
                        ? row.nameAr
                        : row.name
                      : (pickLocalizedName(row.item.product, isRtl) ?? t('Product', 'منتج'));
                  const amount =
                    row.kind === 'bundle' ? row.total : row.item.price * row.item.quantity;
                  return (
                    <li key={row.key} data-testid="receipt-line" className="flex gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="font-medium">
                          <span className={`${styles.mono} opacity-60`}>{localize(qty)}×</span>{' '}
                          {name}
                        </p>
                        {row.kind === 'item' && row.item.variantName && (
                          <p className="mt-0.5 text-xs text-[#141414]/55">
                            <bdi>{row.item.variantName}</bdi>
                          </p>
                        )}
                        {row.kind === 'item' && (
                          <CartLineNote
                            note={row.item.personalisation}
                            className="mt-0.5 text-xs text-[#141414]/55"
                          />
                        )}
                      </div>
                      <p className={`${styles.mono} shrink-0`}>{formatPrice(amount)}</p>
                    </li>
                  );
                })}
              </ul>

              <hr className={`${styles.rule} my-4 border-0`} />

              <Totals
                order={order}
                paid={paid}
                formatPrice={formatPrice}
                t={t}
                ar={language === 'ar'}
              />

              <hr className={`${styles.rule} my-4 border-0`} />

              <dl className="space-y-1.5 text-xs">
                <MetaRow label={t('Order no.', 'رقم الطلب')} ar={language === 'ar'}>
                  <span dir="ltr">#{order.orderNumber}</span>
                </MetaRow>
                {paymentLabel(order, paymentState, language) && (
                  <MetaRow label={t('Payment', 'طريقة الدفع')} ar={language === 'ar'}>
                    {paymentLabel(order, paymentState, language)}
                  </MetaRow>
                )}
                <MetaRow label={t('Date', 'التاريخ')} ar={language === 'ar'}>
                  {formatDate(order.createdAt, {
                    timezone: store.timezone,
                    language,
                    numerals,
                    style: 'short',
                  })}
                </MetaRow>
              </dl>

              <div className="mt-6 flex flex-col items-center gap-1.5 pb-4">
                <Barcode value={order.orderNumber} className="h-11 w-[78%] text-[#141414]" />
                <p
                  data-testid="receipt-barcode-caption"
                  dir="ltr"
                  className={`${styles.mono} text-[11px] tracking-[0.3em] text-[#141414]/60`}
                >
                  #{order.orderNumber}
                </p>
              </div>
            </article>
          </div>
        )}
      </div>

      {!order && !loading && (
        <p className="mt-2 text-center text-sm text-muted-foreground">
          {t(
            'Your order has been received. You can track its status anytime from your account.',
            'تم استلام طلبك. يمكنك متابعة حالته في أي وقت من حسابك.'
          )}
        </p>
      )}
    </section>
  );
}

function Totals({
  order,
  paid,
  formatPrice,
  t,
  ar,
}: {
  order: Order;
  paid: boolean;
  formatPrice: (n: number) => string;
  t: (en: string, ar: string) => string;
  ar: boolean;
}) {
  const tax = orderTaxPlacement({
    tax: order.tax ?? 0,
    taxIncludedInPrice: order.taxIncludedInPrice,
  });
  const wallet = order.walletAmount ?? 0;
  return (
    <dl className="space-y-1.5">
      {typeof order.subtotal === 'number' && (
        <MoneyRow label={t('Subtotal', 'المجموع الفرعي')} ar={ar}>
          {formatPrice(order.subtotal)}
        </MoneyRow>
      )}
      {(order.discount ?? 0) > 0 && (
        <MoneyRow label={t('Discount', 'الخصم')} ar={ar}>
          <span dir="ltr">−{formatPrice(order.discount ?? 0)}</span>
        </MoneyRow>
      )}
      {typeof order.shipping === 'number' && (
        <MoneyRow label={t('Shipping', 'الشحن')} ar={ar}>
          {order.shipping > 0 ? formatPrice(order.shipping) : t('Free', 'مجاني')}
        </MoneyRow>
      )}
      {(order.codFee ?? 0) > 0 && (
        <MoneyRow label={t('Cash on delivery fee', 'رسوم الدفع عند الاستلام')} ar={ar}>
          {formatPrice(order.codFee ?? 0)}
        </MoneyRow>
      )}
      {(tax.taxRow ?? 0) > 0 && (
        <MoneyRow label={t('Tax', 'الضريبة')} ar={ar}>
          {formatPrice(tax.taxRow ?? 0)}
        </MoneyRow>
      )}
      <div className="flex items-baseline justify-between gap-3 pt-2">
        <dt
          className={`font-bold ${ar ? 'text-sm' : `${styles.mono} text-xs uppercase tracking-[0.08em]`}`}
        >
          {paid ? t('Total paid', 'المدفوع') : t('Total', 'الإجمالي')}
        </dt>
        <dd className={`${styles.mono} text-lg font-bold`}>{formatPrice(order.total)}</dd>
      </div>
      {tax.includedTaxCaption !== null && (
        <MoneyRow label={t('Incl. VAT', 'شامل ضريبة القيمة المضافة')} ar={ar}>
          {formatPrice(tax.includedTaxCaption)}
        </MoneyRow>
      )}
      {wallet > 0 && (
        <>
          <MoneyRow label={t('From wallet', 'من المحفظة')} ar={ar}>
            <span dir="ltr">−{formatPrice(wallet)}</span>
          </MoneyRow>
          <MoneyRow label={t('Amount due', 'المبلغ المستحق')} ar={ar}>
            {formatPrice(Math.max(0, order.total - wallet))}
          </MoneyRow>
        </>
      )}
    </dl>
  );
}

/** Label at the start, amount at the end; English labels set as mono small caps. */
function MoneyRow({ label, ar, children }: { label: string; ar: boolean; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <dt
        className={
          ar ? 'text-[#141414]/60' : `${styles.mono} uppercase tracking-[0.08em] text-[#141414]/60`
        }
      >
        {label}
      </dt>
      <dd className={styles.mono}>{children}</dd>
    </div>
  );
}
const MetaRow = MoneyRow;

/** The order's payment method, localized through the shared label helper. */
function paymentLabel(order: Order, state: PaymentState, lang: 'ar' | 'en'): string | null {
  const p = order.payments?.[0];
  if (p?.provider) {
    // Gateways (Paymob/Kashier) record HOW the customer paid (card, wallet…);
    // COD / InstaPay / Fawry are their own method.
    const gateway = p.provider === 'paymob' || p.provider === 'kashier';
    return gateway && p.method
      ? paymentMethodLabel(p.method, lang)
      : paymentProviderLabel(p.provider, lang);
  }
  return state === 'cod' ? paymentProviderLabel('cod', lang) : null;
}

/** "قطعة واحدة" / "قطعتين" / "٣ قطع" / "١١ قطعة". */
function arabicPieces(n: number, localize: (v: number) => string): string {
  if (n === 1) return 'قطعة واحدة';
  if (n === 2) return 'قطعتين';
  return `${localize(n)} ${n <= 10 ? 'قطع' : 'قطعة'}`;
}

function statusCopy(kind: StatusKind, t: (en: string, ar: string) => string): string {
  switch (kind) {
    case 'printing':
    case 'verifying':
      return t('Printing your receipt…', 'بنطبع فاتورتك…');
    case 'paid':
      return t('Paid, order confirmed', 'تم الدفع، طلبك اتأكد');
    case 'cod':
      return t('Order placed, pay on delivery', 'طلبك اتسجل، الدفع عند الاستلام');
    case 'awaiting':
      return t('Order placed, awaiting payment', 'طلبك اتسجل، في انتظار الدفع');
    case 'pending':
      return t('Order placed, confirming payment', 'طلبك اتسجل، بنأكد الدفع');
    case 'failed':
      return t('Payment failed', 'الدفع ما تمش');
    case 'unknown':
    default:
      return t('Order received', 'طلبك وصل');
  }
}

function StatusIcon({ kind }: { kind: StatusKind }) {
  const common = 'h-4 w-4 shrink-0';
  if (kind === 'printing' || kind === 'verifying') {
    return (
      <span
        data-testid="receipt-status-icon"
        data-state={kind}
        aria-hidden="true"
        className={`${common} rounded-full border-2 border-current border-t-transparent opacity-70 motion-safe:animate-spin`}
      />
    );
  }
  const tone =
    kind === 'paid' || kind === 'cod'
      ? 'hsl(var(--success))'
      : kind === 'failed'
        ? 'hsl(var(--destructive))'
        : kind === 'awaiting' || kind === 'pending'
          ? 'hsl(var(--warning))'
          : 'currentColor';
  return (
    <svg
      data-testid="receipt-status-icon"
      data-state={kind}
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={common}
    >
      <circle cx="8" cy="8" r="8" fill={tone} opacity={kind === 'unknown' ? 0.35 : 1} />
      {kind === 'paid' || kind === 'cod' || kind === 'unknown' ? (
        <path
          d="M4.6 8.3l2.2 2.2 4.6-4.8"
          fill="none"
          stroke="#fff"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={styles.draw}
        />
      ) : kind === 'failed' ? (
        <path d="M8 4.2v4.6M8 11.2v.4" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />
      ) : (
        <path
          d="M8 4.6V8l2.2 1.4"
          fill="none"
          stroke="#141414"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}
