'use client';

/**
 * PaymentLinkTab — extracted from /stores/[id]/payment-link/page.tsx.
 * Merchant-initiated payment links (from the store's own gateway) via WhatsApp.
 */

import { useState, useEffect, useCallback } from 'react';
import { Button, useToast } from '@force/ui';
import { apiGet, apiPost } from '../../lib/api';
import { formatPrice } from '../../lib/format';
import { useT } from '../../i18n/useT';
import { paymentLinkErrorMessage } from './payment-link-errors';

import { minorToDecimalString, roundToMinor, REGION } from '@force/shared';
interface PaymentLinkResponse {
  paymentUrl: string;
  orderId: string;
  orderNumber: string;
  invoiceId: string | null;
  totalFils: number;
  currency: string;
  messageId?: string;
  expiresAt: string;
}

interface ProductOption {
  id: string;
  name: string;
  price: number;
  sku: string | null;
}

const SendIcon = ({ className }: { className?: string }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
  >
    <line x1="22" y1="2" x2="11" y2="13" />
    <polygon points="22 2 15 22 11 13 2 9 22 2" />
  </svg>
);

const CopyIcon = ({ className }: { className?: string }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
  >
    <rect x="9" y="9" width="13" height="13" rx="2" />
    <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
  </svg>
);

const CheckIcon = ({ className }: { className?: string }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
  >
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

const PlusIcon = ({ className }: { className?: string }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
  >
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

const TrashIcon = ({ className }: { className?: string }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
  >
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
    <path d="M10 11v6M14 11v6" />
    <path d="M9 6V4h6v2" />
  </svg>
);

interface CartLine {
  productId: string;
  quantity: number;
}

export function PaymentLinkTab({ storeId }: { storeId: string }) {
  const { success: toastSuccess, error: toastError } = useToast();
  const t = useT('whatsappIntegration.paymentLink');

  const [customerPhone, setCustomerPhone] = useState(REGION.phone.callingCode);
  const [customerName, setCustomerName] = useState('');
  const [language, setLanguage] = useState<'en' | 'ar'>('en');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<PaymentLinkResponse | null>(null);
  const [copied, setCopied] = useState(false);

  const [products, setProducts] = useState<ProductOption[]>([]);
  const [loadingProducts, setLoadingProducts] = useState(true);
  const [cartLines, setCartLines] = useState<CartLine[]>([{ productId: '', quantity: 1 }]);
  // Extra out-of-catalogue charge (custom quote, deposit, service fee).
  // Stored as EGP string in the input, converted to piastres at send time.
  const [extraAmountMajor, setExtraAmountMajor] = useState('');
  const [extraAmountNote, setExtraAmountNote] = useState('');
  // Per-line typeahead query — keyed by line index. Each row has its own
  // search box so the merchant can type to find a product from a 1000+
  // catalogue without scrolling a flat dropdown.
  const [lineQueries, setLineQueries] = useState<Record<number, string>>({});

  const loadProducts = useCallback(async () => {
    setLoadingProducts(true);
    try {
      // 1000 covers every active Ebda catalogue today (Wady Aljuz
      // tops at ~235). For catalogues that grow past 1000 the next
      // iteration should switch to server-side `?search=` paging.
      const { data } = await apiGet<{ products: ProductOption[] }>(
        `/api/v1/stores/${storeId}/products?status=active&take=1000`
      );
      if (data?.products) setProducts(data.products);
    } catch {
      // Non-fatal
    } finally {
      setLoadingProducts(false);
    }
  }, [storeId]);

  useEffect(() => {
    loadProducts();
  }, [loadProducts]);

  const phoneValid = /^\+[1-9]\d{6,14}$/.test(customerPhone.trim());
  const validLines = cartLines.filter(l => l.productId && l.quantity > 0);

  // Parse extra amount (EGP with up to 2 decimals → piastres).
  const extraFils = (() => {
    const v = extraAmountMajor.trim();
    if (!v) return 0;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return 0;
    return roundToMinor(n);
  })();

  const canSend = phoneValid && (validLines.length > 0 || extraFils > 0) && !sending;

  const itemsSubtotalFils = validLines.reduce((sum, line) => {
    const product = products.find(p => p.id === line.productId);
    return sum + (product ? product.price * line.quantity : 0);
  }, 0);
  const totalFils = itemsSubtotalFils + extraFils;

  const addLine = () => setCartLines(prev => [...prev, { productId: '', quantity: 1 }]);
  const removeLine = (idx: number) => {
    setCartLines(prev => prev.filter((_, i) => i !== idx));
    setLineQueries(prev => {
      const { [idx]: _drop, ...rest } = prev;
      void _drop;
      return rest;
    });
  };
  const updateLine = (idx: number, patch: Partial<CartLine>) =>
    setCartLines(prev => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));

  // Filter the product list by the per-line search query (case-insensitive,
  // matches name OR sku). Cap suggestions to 10 to keep the dropdown fast.
  const filterProducts = (query: string): ProductOption[] => {
    const q = query.trim().toLowerCase();
    if (!q) return products.slice(0, 10);
    return products
      .filter(p => p.name.toLowerCase().includes(q) || (p.sku && p.sku.toLowerCase().includes(q)))
      .slice(0, 10);
  };

  const send = async () => {
    if (!canSend) return;
    setSending(true);
    setResult(null);
    try {
      const { data: payload, error } = await apiPost<PaymentLinkResponse>(
        `/api/v1/stores/${storeId}/payment-links`,
        {
          customerPhone: customerPhone.trim(),
          customerName: customerName.trim() || undefined,
          items: validLines.length
            ? validLines.map(l => ({ productId: l.productId, quantity: l.quantity }))
            : undefined,
          extraAmountFils: extraFils > 0 ? extraFils : undefined,
          extraAmountNote: extraFils > 0 ? extraAmountNote.trim() || undefined : undefined,
          language,
        }
      );
      if (error) {
        toastError(t('toastCouldNotSendTitle'), paymentLinkErrorMessage(error, t));
        return;
      }
      if (payload) {
        setResult(payload);
        toastSuccess(t('toastSentTitle'), t('toastSentBody', { phone: customerPhone }));
      }
    } catch (err) {
      toastError(t('toastSendFailedTitle'), err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  const copyUrl = async () => {
    if (!result?.paymentUrl) return;
    try {
      await navigator.clipboard.writeText(result.paymentUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <p className="text-sm text-muted-foreground">{t('description')}</p>

      <div className="rounded-lg border bg-card shadow-sm p-5 space-y-4">
        {/* Phone */}
        <div className="space-y-1.5">
          <label htmlFor="pl-phone" className="text-sm font-medium text-foreground">
            {t('phoneLabel')}
          </label>
          <input
            id="pl-phone"
            type="tel"
            value={customerPhone}
            onChange={e => setCustomerPhone(e.target.value)}
            placeholder={REGION.phone.placeholderIntl}
            className="w-full rounded-md border bg-background text-foreground px-3 py-2 text-sm font-mono"
          />
          {!phoneValid && customerPhone.length > 4 && (
            <p className="text-[11px] text-red-600 dark:text-red-400">{t('phoneError')}</p>
          )}
        </div>

        {/* Name */}
        <div className="space-y-1.5">
          <label htmlFor="pl-name" className="text-sm font-medium text-foreground">
            {t('nameLabel')}
          </label>
          <input
            id="pl-name"
            type="text"
            value={customerName}
            onChange={e => setCustomerName(e.target.value)}
            placeholder="Ahmad"
            className="w-full rounded-md border bg-background text-foreground px-3 py-2 text-sm"
          />
        </div>

        {/* Items — typeahead search per line (scales past 1000 products) */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium text-foreground">
              {t('itemsLabel')} {validLines.length > 0 && `(${validLines.length})`}
            </label>
            <button
              type="button"
              onClick={addLine}
              className="inline-flex items-center gap-1 text-xs text-orange-600 hover:text-orange-700 font-medium"
            >
              <PlusIcon className="h-3.5 w-3.5" />
              {t('addItem')}
            </button>
          </div>
          {cartLines.map((line, idx) => {
            const selected = products.find(p => p.id === line.productId);
            const query = lineQueries[idx] ?? '';
            const showSuggestions = !line.productId; // hide suggestions once picked
            const suggestions = filterProducts(query);
            return (
              <div key={idx} className="space-y-1">
                <div className="flex items-start gap-2">
                  <div className="flex-1 min-w-0">
                    {selected ? (
                      <div className="flex items-center justify-between rounded-md border bg-muted/40 px-3 py-2 text-sm">
                        <span className="truncate text-foreground">
                          {selected.name} —{' '}
                          <span className="font-mono tabular-nums text-muted-foreground">
                            {formatPrice(selected.price)}
                          </span>
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            updateLine(idx, { productId: '' });
                            setLineQueries(prev => ({ ...prev, [idx]: '' }));
                          }}
                          className="ms-2 text-xs text-orange-600 hover:text-orange-700 font-medium"
                        >
                          {t('change')}
                        </button>
                      </div>
                    ) : (
                      <input
                        type="text"
                        value={query}
                        onChange={e => setLineQueries(prev => ({ ...prev, [idx]: e.target.value }))}
                        disabled={loadingProducts}
                        placeholder={
                          loadingProducts
                            ? t('loadingProducts')
                            : t('searchProducts', { count: products.length })
                        }
                        className="w-full rounded-md border bg-background text-foreground px-3 py-2 text-sm"
                      />
                    )}
                    {showSuggestions &&
                      suggestions.length > 0 &&
                      (query || products.length > 0) && (
                        <div className="relative z-10 mt-1 max-h-60 overflow-y-auto rounded-md border bg-card shadow-md">
                          {suggestions.map(p => (
                            <button
                              key={p.id}
                              type="button"
                              onClick={() => {
                                updateLine(idx, { productId: p.id });
                                setLineQueries(prev => ({ ...prev, [idx]: '' }));
                              }}
                              className="block w-full px-3 py-2 text-start text-sm hover:bg-orange-50 dark:hover:bg-orange-950/30"
                            >
                              <div className="truncate font-medium text-foreground">{p.name}</div>
                              <div className="text-[11px] text-muted-foreground font-mono tabular-nums">
                                {formatPrice(p.price)}
                                {p.sku ? ` · ${p.sku}` : ''}
                              </div>
                            </button>
                          ))}
                        </div>
                      )}
                  </div>
                  <input
                    type="number"
                    min="1"
                    max="99"
                    value={line.quantity}
                    onChange={e =>
                      updateLine(idx, { quantity: Math.max(1, parseInt(e.target.value) || 1) })
                    }
                    className="w-16 rounded-md border bg-background text-foreground px-2 py-2 text-sm tabular-nums text-center"
                  />
                  {cartLines.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeLine(idx)}
                      className="text-red-400 hover:text-red-600 p-1 mt-1"
                      aria-label={t('removeItemAriaLabel')}
                    >
                      <TrashIcon className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Extra amount — custom charge with no Product. Webhook reconciles
            against Order.total which already includes this. */}
        <div className="space-y-2 rounded-md border border-dashed border-border bg-muted/40 p-3">
          <label className="text-sm font-medium text-foreground">{t('customAmountLabel')}</label>
          <p className="text-[11px] text-muted-foreground -mt-1">{t('customAmountHint')}</p>
          <div className="flex items-center gap-2">
            <input
              type="number"
              step="0.01"
              min="0"
              value={extraAmountMajor}
              onChange={e => setExtraAmountMajor(e.target.value)}
              placeholder="0.00"
              className="w-32 rounded-md border bg-background text-foreground px-3 py-2 text-sm font-mono tabular-nums"
            />
            <span className="text-sm text-muted-foreground">EGP</span>
            <input
              type="text"
              value={extraAmountNote}
              onChange={e => setExtraAmountNote(e.target.value)}
              placeholder={t('customAmountNote')}
              maxLength={200}
              className="flex-1 rounded-md border bg-background text-foreground px-3 py-2 text-sm"
            />
          </div>
        </div>

        {/* Total summary */}
        {totalFils > 0 && (
          <div className="rounded-md border bg-primary/10 p-3 text-sm space-y-0.5">
            {itemsSubtotalFils > 0 && (
              <div className="flex justify-between text-foreground">
                <span>{t('itemsSubtotal')}</span>
                <span className="font-mono tabular-nums">
                  {minorToDecimalString(itemsSubtotalFils)} {language === 'ar' ? 'ج.م' : 'EGP'}
                </span>
              </div>
            )}
            {extraFils > 0 && (
              <div className="flex justify-between text-foreground">
                <span>
                  {t('customAmount')}
                  {extraAmountNote ? ` (${extraAmountNote})` : ''}
                </span>
                <span className="font-mono tabular-nums">
                  {minorToDecimalString(extraFils)} {language === 'ar' ? 'ج.م' : 'EGP'}
                </span>
              </div>
            )}
            <div className="flex justify-between font-semibold text-foreground pt-1 border-t border-primary/30">
              <span>{t('total')}</span>
              <span className="font-mono tabular-nums">
                {minorToDecimalString(totalFils)} {language === 'ar' ? 'ج.م' : 'EGP'}
              </span>
            </div>
          </div>
        )}

        {/* Language */}
        <div className="space-y-1.5">
          <label htmlFor="pl-lang" className="text-sm font-medium text-foreground">
            {t('messageLanguage')}
          </label>
          <select
            id="pl-lang"
            value={language}
            onChange={e => setLanguage(e.target.value as 'en' | 'ar')}
            className="w-full rounded-md border bg-background text-foreground px-3 py-2 text-sm"
          >
            <option value="en">{t('langEn')}</option>
            <option value="ar">{t('langAr')}</option>
          </select>
        </div>

        <Button
          onClick={send}
          disabled={!canSend}
          className="w-full bg-orange-500 hover:bg-orange-600"
        >
          <SendIcon className="me-2 h-4 w-4" />
          {sending ? t('sending') : t('sendLink')}
        </Button>
      </div>

      {result && (
        <div className="rounded-lg border bg-emerald-50 border-emerald-200 p-4 space-y-3">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-emerald-900">
            <CheckIcon className="h-4 w-4" />
            {t('sentTitle')}
          </h3>
          <div className="text-xs text-emerald-800 space-y-1.5">
            <p>{t('sentDescription')}</p>
            <p className="flex items-center gap-2 flex-wrap text-[11px] text-emerald-700">
              <span className="font-mono">
                {t('orderNumberLabel', { orderNumber: result.orderNumber })}
              </span>
              {result.invoiceId && (
                <span className="font-mono">
                  · {t('invoiceIdLabel', { invoiceId: result.invoiceId })}
                </span>
              )}
              <a
                href={`/stores/${storeId}/orders/${result.orderId}`}
                className="ms-auto inline-flex items-center gap-1 rounded-md border border-emerald-300 bg-white px-2.5 py-1 text-emerald-700 hover:bg-emerald-100 font-medium"
              >
                {t('viewOrder')}
              </a>
            </p>
            <div className="flex items-center gap-2 mt-2">
              <input
                type="text"
                readOnly
                value={result.paymentUrl}
                className="flex-1 rounded border bg-white px-2 py-1 text-[11px] font-mono"
                onFocus={e => e.target.select()}
              />
              <Button onClick={copyUrl} variant="outline" className="h-7 px-2 text-xs">
                {copied ? (
                  <CheckIcon className="h-3.5 w-3.5" />
                ) : (
                  <CopyIcon className="h-3.5 w-3.5" />
                )}
              </Button>
            </div>
            {result.messageId && (
              <p className="text-[10px] text-emerald-600 font-mono">
                {t('metaMessageId')} {result.messageId}
              </p>
            )}
          </div>
        </div>
      )}

      <div className="rounded-md border bg-blue-50/50 dark:bg-blue-950/20 border-blue-200 dark:border-blue-800 p-3 text-xs text-blue-800 dark:text-blue-300">
        {t('requirements')}
      </div>
    </div>
  );
}
