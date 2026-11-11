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
import { VariantText, ReceiptPrinterShell } from '@ebda/ui';
import { useEffect, useState, type ReactNode } from 'react';
import { groupOrderLinesForDisplay, orderTaxPlacement, orderLineVariantTitle } from '@ebda/shared';
import type { Order } from '@/lib/api';
import { MINUS, signedText } from '@/lib/bidi';
import type { StoreData } from '@/contexts/StoreContext';
import type { StoreTheme } from '@ebda/shared';
import { useLanguage } from '@/contexts/LanguageContext';
import { useLocalePrice } from '@/hooks/useLocalePrice';
import { useNumerals } from '@/hooks/useNumerals';
import { formatDate } from '@/lib/format-date';
import { paymentMethodLabel, paymentProviderLabel } from '@/lib/order-labels';
import { pickLocalizedName } from '@/templates/shared/display-helpers';
import { goldSnapshotLine } from '@/lib/gold-display';
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

type ReceiptStore = Pick<
  StoreData,
  'name' | 'nameAr' | 'logo' | 'logoAr' | 'timezone' | 'settings'
> & {
  /** K-07: a look's `receiptStyle` (`framed` = paper in the page ink, no device slab). */
  theme?: Pick<StoreTheme, 'receiptStyle'> | null;
};

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

/** Status crossfade length; mirrors `.statusIn` / `.statusOut` in the CSS module. */
const SWAP_MS = 150;
/** Before the order arrives the empty slot holds about a two-line receipt (the
 *  common Egyptian basket), so the one jump at load is a line or two at most.
 *  Measured on the local stack: see task-10-report.md, fix round 1. */
const LOADING_RESERVE = 'min-h-[32rem]';

/** Western digit runs ("4,310", "2026/10/15") in the mono face; everything else
 *  (Arabic-Indic digits, "ج.م", "EGP", spaces) stays in the body font, so no
 *  Arabic glyph or word space is ever set in a Latin mono. */
const LATIN_NUMBER = /([0-9](?:[0-9,.:/-]*[0-9])?)/;
function Num({ children }: { children: string }) {
  return (
    <span className="tabular-nums">
      {children.split(LATIN_NUMBER).map((part, i) =>
        i % 2 === 1 ? (
          // T-04: digit runs stay in the body face (tabular figures above); mono is the code only.
          <span key={i} dir="ltr">
            {part}
          </span>
        ) : (
          part
        )
      )}
    </span>
  );
}

type StatusKind = 'printing' | PaymentState;

/**
 * IA-14: an order number read out to a courier, in groups. "ORD-TMZRB9-IR5JY" prints as
 * "TMZRB9 · IR5JY" (the ORD prefix says nothing the label does not); a plain "1043" is
 * unchanged. The full value stays the element's accessible name.
 */
export function groupOrderNumber(orderNumber: string): string {
  const parts = orderNumber.split('-').filter(Boolean);
  if (parts.length > 1 && /^ord$/i.test(parts[0])) parts.shift();
  return parts.join(' · ');
}

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

  const ar = language === 'ar';
  const storeName = pickLocalizedName(store, ar) ?? '';
  const logo = language === 'ar' && store.logoAr ? store.logoAr : store.logo;
  const rows = order ? groupOrderLinesForDisplay(order.items) : [];
  const paid = paymentState === 'paid';
  const payment = order ? paymentLabel(order, paymentState, language) : null;
  const framed = store.theme?.receiptStyle === 'framed';

  return (
    <ReceiptPrinterShell
      framed={framed}
      feedKey={order?.id ?? null}
      ariaLabel={t('Order receipt', 'فاتورة الطلب')}
      loadingReserve={LOADING_RESERVE}
      paperClassName="px-5 pt-6 text-sm leading-snug"
      screen={({ feedDone }) => (
        <PrinterScreen
          order={order}
          loading={loading}
          paymentState={paymentState}
          feedDone={feedDone}
        />
      )}
    >
      {order && (
        <>
          <h2 className="flex justify-center">
            {logo ? (
              <img src={logo} alt={storeName} className="h-9 w-auto max-w-[60%] object-contain" />
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
              const amount = row.kind === 'bundle' ? row.total : row.item.price * row.item.quantity;
              const variant = row.kind === 'item' ? orderLineVariantTitle(row.item, ar) : null;
              return (
                <li key={row.key} data-testid="receipt-line" className="flex gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">
                      <span className="opacity-80">
                        <Num>{localize(qty)}</Num>×
                      </span>{' '}
                      {name}
                    </p>
                    {variant && (
                      <p className={`mt-0.5 text-xs ${styles.inkMuted}`}>
                        <VariantText title={variant} />
                      </p>
                    )}
                    {row.kind === 'item' && row.item.goldSnapshot && (
                      <p
                        data-testid="receipt-gold-line"
                        className={`mt-0.5 text-xs ${styles.inkMuted}`}
                      >
                        {goldSnapshotLine(
                          row.item.goldSnapshot,
                          ar ? 'ar' : 'en',
                          formatPrice,
                          localize
                        )}
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
            {order.deliveryLine && (
              <MetaRow label={t('Delivery', 'التوصيل')} ar={ar}>
                <span data-testid="receipt-delivery-pick">{order.deliveryLine}</span>
              </MetaRow>
            )}
            {/* S-02: when it arrives, from the store's own zones/settings. A
                    failed payment is not on its way, so it gets no window. */}
            {deliveryWindow && paymentState !== 'failed' && (
              <MetaRow label={t('Arrives', 'موعد الوصول')} ar={ar}>
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
                {t('Questions? Message the store on WhatsApp', 'عندك سؤال؟ كلّم المتجر على واتساب')}
              </a>
            </p>
          )}

          <div className="mt-6 flex flex-col items-center gap-1.5 pb-4">
            <Barcode
              value={order.orderNumber}
              shape={store.settings?.receiptBarcodeShape as string | undefined}
              className={`block w-full ${styles.ink}`}
            />
            <p className={`text-xs ${styles.inkSoft}`}>{t('Order number', 'رقم الطلب')}</p>
            <p
              data-testid="receipt-order-number"
              dir="ltr"
              className={`${styles.mono} text-xl font-semibold ${styles.ink}`}
            >
              {/* QA-D5: the FULL number, the one the merchant's admin list and the courier message use. The
                  grouped "TMZRB9 · IR5JY" plus a screen-reader copy printed the number twice in text. */}
              #{order.orderNumber}
            </p>
          </div>
        </>
      )}
    </ReceiptPrinterShell>
  );
}

/** The printer's screen: order line, total and the crossfading status line. */
function PrinterScreen({
  order,
  loading,
  paymentState,
  feedDone,
}: {
  order: Order | null;
  loading: boolean;
  paymentState: PaymentState;
  feedDone: boolean;
}) {
  const { t } = useLanguage();
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

  // Taste re-audit P2-5 (Y-05): the head carries the live payment status only; the page
  // headline names the order and the paper lists its items (IA-14 moved the number and total there).
  return (
    <>
      <div className="grid min-h-5 text-xs" aria-live="polite" role="status">
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
    </>
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
        <dt className="font-bold text-sm">
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

/** Label at the start, value at the end, both in the body face (T-04: no tracked mono caps). */
function MoneyRow({ label, children }: { label: string; ar?: boolean; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <dt className={styles.inkSoft}>{label}</dt>
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
      return t('Printing your receipt…', 'بنطبع فاتورتك…');
    case 'paid':
      return t('Paid, order confirmed', 'اتدفع، طلبك اتأكد');
    case 'cod':
      return t('Order placed, pay on delivery', 'طلبك اتسجل، الدفع عند الاستلام');
    case 'awaiting':
      return t('Order placed, awaiting payment', 'طلبك اتسجل، في انتظار الدفع');
    case 'pending':
      return t('Order placed, confirming payment', 'طلبك اتسجل، بنأكد الدفع');
    case 'failed':
      return t('Payment failed', 'الدفع متمش');
    case 'unknown':
    default:
      return t('Order received', 'طلبك وصل');
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
