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
import { VariantText } from '@ebda/ui';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { groupOrderLinesForDisplay, orderTaxPlacement, orderLineVariantTitle } from '@ebda/shared';
import type { Order } from '@/lib/api';
import { MINUS, signedText } from '@/lib/bidi';
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
import { countText, ITEMS } from '@/lib/plural';

/** The success page's verified payment outcome (SuccessClient owns it). */
export type PaymentState =
  | 'verifying'
  | 'paid'
  | 'pending'
  | 'failed'
  | 'cod'
  | 'awaiting'
  | 'unknown';

type ReceiptStore = Pick<StoreData, 'name' | 'nameAr' | 'logo' | 'logoAr' | 'timezone'>;

export interface ReceiptPrinterProps {
  order: Order | null;
  paymentState: PaymentState;
  store: ReceiptStore;
  /** The order is still being fetched: printer + spinner + empty slot. */
  loading?: boolean;
  /**
   * S-02: the store's delivery window from the order's date (`useDeliveryWindow`),
   * already formatted; null/absent = the store has no delivery numbers → no row.
   */
  deliveryWindow?: { from: string; to: string } | null;
  /** S-02: the store's "ask about this order" wa.me link; null/absent = no line. */
  whatsappHref?: string | null;
}

const REDUCED = '(prefers-reduced-motion: reduce)';
/** Mirror the `.feeding` animation in ReceiptPrinter.module.css. */
const FEED_DELAY_MS = 250;
const FEED_MS = 1600;
/** Status crossfade length; mirrors `.statusIn` / `.statusOut` in the CSS module. */
const SWAP_MS = 150;
/** Before the order arrives the empty slot holds about a two-line receipt (the
 *  common Egyptian basket), so the one jump at load is a line or two at most.
 *  Measured on the local stack: see task-10-report.md, fix round 1. */
const LOADING_RESERVE = 'min-h-[32rem]';
const printedKey = (orderId: string) => `receipt-printed:${orderId}`;

/** Western digit runs ("4,310", "2026/10/15") in the mono face; everything else
 *  (Arabic-Indic digits, "ج.م", "EGP", spaces) stays in the body font, so no
 *  Arabic glyph or word space is ever set in a Latin mono. */
const LATIN_NUMBER = /([0-9](?:[0-9,.:/-]*[0-9])?)/;
function Num({ children }: { children: string }) {
  return (
    <span className="tabular-nums">
      {children.split(LATIN_NUMBER).map((part, i) =>
        i % 2 === 1 ? (
          <span key={i} className={styles.mono}>
            {part}
          </span>
        ) : (
          part
        )
      )}
    </span>
  );
}

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
  deliveryWindow = null,
  whatsappHref = null,
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

  // Crossfade: when the status changes, the old line stays for one 150ms
  // fade-out on top of the new line's fade-in (derived state, set in render).
  const [shown, setShown] = useState<StatusKind>(status);
  const [leaving, setLeaving] = useState<StatusKind | null>(null);
  if (status !== shown) {
    setLeaving(shown);
    setShown(status);
  }
  useEffect(() => {
    if (!leaving) return;
    // Backstop for reduced motion (no animation, so no animationend).
    const timer = window.setTimeout(() => setLeaving(null), SWAP_MS + 50);
    return () => window.clearTimeout(timer);
  }, [leaving]);

  const ar = language === 'ar';
  const storeName = pickLocalizedName(store, ar) ?? '';
  const logo = language === 'ar' && store.logoAr ? store.logoAr : store.logo;
  const rows = order ? groupOrderLinesForDisplay(order.items) : [];
  // A bundle box counts once, as the customer bought it.
  const itemCount = rows.reduce(
    (n, r) => n + (r.kind === 'bundle' ? r.quantity : r.item.quantity),
    0
  );
  const paid = paymentState === 'paid';
  const payment = order ? paymentLabel(order, paymentState, language) : null;

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
                      countText('en', itemCount, ITEMS),
                      countText('ar', itemCount, ITEMS, localize(itemCount))
                    )
                  : storeName}
              </p>
            </div>
            {order && (
              <div className="shrink-0 text-end">
                <p className="text-xs opacity-60">{t('Order total', 'إجمالي الطلب')}</p>
                <p className="text-base font-semibold">
                  <Num>{formatPrice(order.total)}</Num>
                </p>
              </div>
            )}
          </div>
          <div className="mt-3 grid min-h-5 text-xs" aria-live="polite" role="status">
            {leaving && (
              <span
                key={`out-${leaving}`}
                aria-hidden="true"
                data-testid="receipt-status-leaving"
                className={`${styles.statusOut} col-start-1 row-start-1 flex items-center gap-2`}
                onAnimationEnd={e => {
                  // Only this line's own fade: a bubbling animationend from a child
                  // (the spinner icon) must not cut the crossfade short.
                  if (e.target === e.currentTarget) setLeaving(null);
                }}
              >
                <StatusIcon kind={leaving} />
                <span>{statusCopy(leaving, t)}</span>
              </span>
            )}
            <span
              key={shown}
              data-testid="receipt-status-current"
              className={`${leaving ? styles.statusIn : ''} col-start-1 row-start-1 flex items-center gap-2`}
            >
              <StatusIcon kind={shown} current />
              <span>{statusCopy(shown, t)}</span>
            </span>
          </div>
        </div>
        <div className={`${styles.slit} mx-2.5 mb-0.5 mt-2 h-1.5 rounded-[var(--radius)]`} />
      </div>

      {/* Paper. While the order loads the slot is empty but holds a typical
          receipt's height; once the order is known the paper is in the flow at
          its final height before the feed starts (the feed is transform-only),
          so the page moves at most once, at load, and never when the feed ends. */}
      <div className={`${styles.window} mx-4 sm:mx-5 ${order ? '' : LOADING_RESERVE}`}>
        {order && (
          <div
            className={`${styles.feeder} ${feed && !feedDone ? styles.feeding : ''}`}
            data-feeding={feed && !feedDone ? 'true' : undefined}
            data-testid="receipt-paper"
            onAnimationEnd={e => {
              if (e.target === e.currentTarget) setFedId(order.id);
            }}
          >
            <article className={`${styles.paper} px-5 pt-6 text-sm leading-snug`}>
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
                      ? (pickLocalizedName(row, ar) ?? t('Bundle', 'باقة'))
                      : (pickLocalizedName(row.item.product, isRtl) ?? t('Product', 'منتج'));
                  const amount =
                    row.kind === 'bundle' ? row.total : row.item.price * row.item.quantity;
                  const variant = row.kind === 'item' ? orderLineVariantTitle(row.item, ar) : null;
                  return (
                    <li key={row.key} data-testid="receipt-line" className="flex gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="font-medium">
                          <span className="opacity-60">
                            <Num>{localize(qty)}</Num>×
                          </span>{' '}
                          {name}
                        </p>
                        {variant && (
                          <p className={`mt-0.5 text-xs ${styles.inkMuted}`}>
                            <VariantText title={variant} />
                          </p>
                        )}
                        {row.kind === 'item' && (
                          <CartLineNote
                            note={row.item.personalisation}
                            className={`mt-0.5 text-xs ${styles.inkMuted}`}
                          />
                        )}
                      </div>
                      <p className="shrink-0">
                        <Num>{formatPrice(amount)}</Num>
                      </p>
                    </li>
                  );
                })}
              </ul>

              <hr className={`${styles.rule} my-4 border-0`} />

              <Totals order={order} paid={paid} formatPrice={formatPrice} t={t} ar={ar} />

              <hr className={`${styles.rule} my-4 border-0`} />

              <dl className="space-y-1.5 text-xs">
                {payment && (
                  <MetaRow label={t('Payment', 'طريقة الدفع')} ar={ar}>
                    <span data-testid="receipt-payment-label">{payment}</span>
                  </MetaRow>
                )}
                <MetaRow label={t('Date', 'التاريخ')} ar={ar}>
                  <Num>
                    {formatDate(order.createdAt, {
                      timezone: store.timezone,
                      language,
                      numerals,
                      style: 'medium',
                    })}
                  </Num>
                </MetaRow>
                {/* S-02: when it arrives, from the store's own zones/settings. A
                    failed payment is not on its way, so it gets no window. */}
                {deliveryWindow && paymentState !== 'failed' && (
                  <MetaRow label={t('Arrives', 'يصلك')} ar={ar}>
                    <span data-testid="receipt-delivery-window">
                      {deliveryWindow.from === deliveryWindow.to
                        ? deliveryWindow.from
                        : `${deliveryWindow.from} – ${deliveryWindow.to}`}
                    </span>
                  </MetaRow>
                )}
              </dl>

              {whatsappHref && (
                <p className="mt-4 text-center text-xs">
                  <a
                    data-testid="receipt-whatsapp"
                    href={whatsappHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`${styles.ink} underline underline-offset-4`}
                  >
                    {t(
                      'Questions? Message the store on WhatsApp',
                      'هل لديك سؤال؟ راسل المتجر على واتساب'
                    )}
                  </a>
                </p>
              )}

              <div className="mt-6 flex flex-col items-center gap-1.5 pb-4">
                <Barcode value={order.orderNumber} className={`h-11 w-[78%] ${styles.ink}`} />
                <p
                  data-testid="receipt-barcode-caption"
                  dir="ltr"
                  className={`${styles.mono} text-xs tracking-[0.3em] ${styles.inkSoft}`}
                >
                  #{order.orderNumber}
                </p>
              </div>
            </article>
          </div>
        )}
      </div>
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
          <Num>{formatPrice(order.subtotal)}</Num>
        </MoneyRow>
      )}
      {(order.discount ?? 0) > 0 && (
        <MoneyRow label={t('Discount', 'الخصم')} ar={ar}>
          <Num>{signedText(MINUS, formatPrice(order.discount ?? 0))}</Num>
        </MoneyRow>
      )}
      {typeof order.shipping === 'number' && (
        <MoneyRow label={t('Shipping', 'الشحن')} ar={ar}>
          {order.shipping > 0 ? <Num>{formatPrice(order.shipping)}</Num> : t('Free', 'مجاني')}
        </MoneyRow>
      )}
      {(order.codFee ?? 0) > 0 && (
        <MoneyRow label={t('Cash on delivery fee', 'رسوم الدفع عند الاستلام')} ar={ar}>
          <Num>{formatPrice(order.codFee ?? 0)}</Num>
        </MoneyRow>
      )}
      {(tax.taxRow ?? 0) > 0 && (
        <MoneyRow label={t('Tax', 'الضريبة')} ar={ar}>
          <Num>{formatPrice(tax.taxRow ?? 0)}</Num>
        </MoneyRow>
      )}
      <div className="flex items-baseline justify-between gap-3 pt-2">
        <dt
          className={`font-bold ${ar ? 'text-sm' : `${styles.mono} text-xs uppercase tracking-[0.08em]`}`}
        >
          {paid ? t('Total paid', 'المدفوع') : t('Total', 'الإجمالي')}
        </dt>
        <dd className="text-lg font-bold" data-testid="receipt-total">
          <Num>{formatPrice(order.total)}</Num>
        </dd>
      </div>
      {tax.includedTaxCaption !== null && (
        <MoneyRow label={t('Incl. VAT', 'شامل ضريبة القيمة المضافة')} ar={ar}>
          <Num>{formatPrice(tax.includedTaxCaption)}</Num>
        </MoneyRow>
      )}
      {wallet > 0 && (
        <>
          <MoneyRow label={t('From wallet', 'من المحفظة')} ar={ar}>
            <Num>{signedText(MINUS, formatPrice(wallet))}</Num>
          </MoneyRow>
          {/* The rest is owed only when nobody charged it yet (COD, transfer);
              on a paid order the gateway already took it. */}
          {!paid && (
            <MoneyRow label={t('Amount due', 'المبلغ المستحق')} ar={ar}>
              <Num>{formatPrice(Math.max(0, order.total - wallet))}</Num>
            </MoneyRow>
          )}
        </>
      )}
    </dl>
  );
}

/** Label at the start, value at the end. English labels are Latin mono small
 *  caps (the receipt voice); Arabic labels and every value stay in the body
 *  font, with only Western digit runs in mono via `Num`. */
function MoneyRow({ label, ar, children }: { label: string; ar: boolean; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <dt
        className={
          ar ? styles.inkSoft : `${styles.mono} uppercase tracking-[0.08em] ${styles.inkSoft}`
        }
      >
        {label}
      </dt>
      <dd>{children}</dd>
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

function statusCopy(kind: StatusKind, t: (en: string, ar: string) => string): string {
  switch (kind) {
    case 'printing':
    case 'verifying':
      return t('Printing your receipt…', 'جارٍ طباعة فاتورتك…');
    case 'paid':
      return t('Paid, order confirmed', 'تم الدفع وتأكيد طلبك');
    case 'cod':
      return t('Order placed, pay on delivery', 'تم تسجيل طلبك، الدفع عند الاستلام');
    case 'awaiting':
      return t('Order placed, awaiting payment', 'تم تسجيل طلبك، في انتظار الدفع');
    case 'pending':
      return t('Order placed, confirming payment', 'تم تسجيل طلبك، جارٍ تأكيد الدفع');
    case 'failed':
      return t('Payment failed', 'لم يكتمل الدفع');
    case 'unknown':
    default:
      return t('Order received', 'تم استلام طلبك');
  }
}

function StatusIcon({ kind, current = false }: { kind: StatusKind; current?: boolean }) {
  const common = 'h-4 w-4 shrink-0';
  const testId = current ? 'receipt-status-icon' : undefined;
  if (kind === 'printing' || kind === 'verifying') {
    return (
      <span
        data-testid={testId}
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
      data-testid={testId}
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
