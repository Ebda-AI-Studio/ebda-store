'use client';

/**
 * Barcode Scan Page — /stores/[id]/stock/scan
 * Enterprise feature: inventory.barcode
 *
 * Three modes:
 *   Receive — scan barcode → enter qty → POST /inventory/receive
 *   Pick    — load order → scan items → track progress
 *   Count   — open/resume session → scan + count → close → reconcile
 *
 * Camera: BarcodeDetector Web API when available (Chrome/Safari mobile).
 * Manual text input fallback for all browsers (Firefox desktop, etc.).
 * No heavy external scanner library — zero new npm deps.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { AdminLayout } from '@/components/AdminLayout';
import { DataTable } from '@/components/mobile/DataTable';
import { useT } from '@/i18n/useT';
import { useFeatures } from '@/hooks/useFeatures';
import { useLocale } from 'next-intl';
import { VariantText } from '@ebda/ui';
import { apiGet, apiPost } from '@/lib/api';
import { orderLineVariantTitle, searchQueryHeaders, withNumerals } from '@ebda/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type Mode = 'receive' | 'pick' | 'count';

/**
 * The text for a failed scan request. A 403 FEATURE_DISABLED (`inventory.barcode` is not on this
 * store's plan) is a plan state, not a missing record, so it must not read "order/barcode not
 * found". Every error site on this page goes through here.
 */
function scanErrorText(
  t: (key: string) => string,
  error: { code: string } | null | undefined,
  fallbackKey: string
): string {
  return error?.code === 'FEATURE_DISABLED' ? t('featureNotOnPlan') : t(fallbackKey);
}

interface LookupResult {
  type: 'product' | 'variant';
  productId: string;
  variantId?: string;
  productName: string;
  productNameAr: string | null;
  variantTitle?: string | null;
  barcode: string;
  sku: string | null;
  inventory: number;
  ambiguous: boolean;
}

interface ReceiveResult {
  productId: string;
  variantId?: string;
  previousInventory: number;
  newInventory: number;
  qtyReceived: number;
}

interface OrderItem {
  id: string;
  productId: string;
  variantId: string | null;
  productName: string;
  variantName: string | null;
  variantNameAr?: string | null;
  personalisation: string | null;
  quantity: number;
  pickedQty: number;
  pickedAt: string | null;
}

interface OrderPickProgress {
  orderId: string;
  orderNumber: string;
  status: string;
  fullyPicked: boolean;
  items: OrderItem[];
}

interface PickResult {
  orderItemId: string;
  productName: string;
  qtyOrdered: number;
  pickedQtyBefore: number;
  pickedQtyAfter: number;
  fullyPicked: boolean;
  orderFullyPicked: boolean;
}

interface CountLine {
  id: string;
  sessionId: string;
  productId: string;
  variantId: string | null;
  productName: string;
  productNameAr: string | null;
  variantTitle: string | null;
  countedQty: number;
  systemQty: number;
  variance: number;
  scannedAt: string;
}

interface CountSession {
  id: string;
  status: string;
  note: string | null;
  createdAt: string;
  closedAt: string | null;
  reconciledAt: string | null;
  adjustmentId: string | null;
  lines: CountLine[];
}

// ─────────────────────────────────────────────────────────────────────────────
// BarcodeDetector Web API type (browser global — not in @types/dom yet)
// ─────────────────────────────────────────────────────────────────────────────
declare class BarcodeDetector {
  constructor(opts?: { formats?: string[] });
  detect(source: ImageBitmapSource): Promise<Array<{ rawValue: string; format: string }>>;
  static getSupportedFormats(): Promise<string[]>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hook: detect BarcodeDetector availability
// ─────────────────────────────────────────────────────────────────────────────
function useBarcodeDetectorSupported(): boolean {
  const [supported, setSupported] = useState(false);
  useEffect(() => {
    setSupported(typeof BarcodeDetector !== 'undefined');
  }, []);
  return supported;
}

// ─────────────────────────────────────────────────────────────────────────────
// Component: CameraScanner
// Renders a <video> element with getUserMedia + BarcodeDetector on each frame.
// ─────────────────────────────────────────────────────────────────────────────
interface CameraScannerProps {
  onDetected: (barcode: string) => void;
  onStop: () => void;
  onError?: (msg: string) => void;
}

function CameraScanner({ onDetected, onStop, onError }: CameraScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number>(0);
  const detectedRef = useRef(false);

  useEffect(() => {
    let active = true;
    const detector = new BarcodeDetector({
      formats: ['ean_13', 'ean_8', 'code_128', 'qr_code', 'upc_a', 'upc_e', 'code_39'],
    });

    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      .then(stream => {
        if (!active) {
          stream.getTracks().forEach(t => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch(() => {});
        }

        const scan = async () => {
          if (!active || detectedRef.current) return;
          if (videoRef.current && videoRef.current.readyState >= 2) {
            try {
              const results = await detector.detect(videoRef.current);
              if (results.length > 0 && results[0].rawValue && !detectedRef.current) {
                detectedRef.current = true;
                onDetected(results[0].rawValue);
              }
            } catch {
              // Detection failed on this frame — continue
            }
          }
          if (active && !detectedRef.current) {
            rafRef.current = requestAnimationFrame(scan);
          }
        };
        rafRef.current = requestAnimationFrame(scan);
      })
      .catch(() => {
        // Camera access denied or unavailable — surface a visible message
        if (onError) {
          onError('camera-permission');
        }
        onStop();
      });

    return () => {
      active = false;
      cancelAnimationFrame(rafRef.current);
      streamRef.current?.getTracks().forEach(t => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="relative w-full max-w-sm mx-auto rounded-xl overflow-hidden border border-border bg-black aspect-[4/3]">
      <video ref={videoRef} className="w-full h-full object-cover" playsInline muted />
      {/* Viewfinder overlay */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div className="w-52 h-32 border-2 border-white/70 rounded-lg" />
      </div>
      <button
        type="button"
        onClick={onStop}
        className="absolute top-2 end-2 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full bg-black/50 text-white text-xs px-3"
      >
        ✕
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Component: BarcodeInput
// Manual text input with optional camera scan button.
// ─────────────────────────────────────────────────────────────────────────────
interface BarcodeInputProps {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  placeholder: string;
  cameraSupported: boolean;
  onOpenCamera: () => void;
  disabled?: boolean;
  cameraError?: string | null;
  t: (key: string) => string;
}

function BarcodeInput({
  value,
  onChange,
  onSubmit,
  placeholder,
  cameraSupported,
  onOpenCamera,
  disabled,
  cameraError,
  t,
}: BarcodeInputProps) {
  return (
    <div className="space-y-1.5">
      <div className="flex gap-2 items-center">
        <input
          type="text"
          value={value}
          onChange={e => onChange(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && value.trim()) {
              e.preventDefault();
              onSubmit(value.trim());
            }
          }}
          placeholder={placeholder}
          className="flex-1 min-h-[44px] rounded-lg border border-border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
          disabled={disabled}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          inputMode="text"
        />
        {cameraSupported && (
          <button
            type="button"
            onClick={onOpenCamera}
            disabled={disabled}
            className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg border border-border bg-muted text-muted-foreground hover:bg-muted/80 text-lg disabled:opacity-50"
            title={t('scanWithCamera')}
          >
            📷
          </button>
        )}
      </div>
      {!cameraSupported && (
        <p className="text-xs text-muted-foreground">{t('cameraNotSupported')}</p>
      )}
      {cameraError === 'camera-permission' && (
        <p className="text-xs text-destructive-ink">{t('cameraPermission')}</p>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-component: ReceiveMode
// ─────────────────────────────────────────────────────────────────────────────
function ReceiveMode({ storeId }: { storeId: string }) {
  const t = useT('stock.scan');
  const cameraSupported = useBarcodeDetectorSupported();
  const [barcode, setBarcode] = useState('');
  const [qty, setQty] = useState(1);
  const [lookup, setLookup] = useState<LookupResult | null>(null);
  const [lookupErr, setLookupErr] = useState<string | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<ReceiveResult | null>(null);
  const [submitErr, setSubmitErr] = useState<string | null>(null);

  const doLookup = useCallback(
    async (bc: string) => {
      setLookupErr(null);
      setLookup(null);
      setResult(null);
      setSubmitErr(null);
      const { data, error } = await apiGet<LookupResult>(
        `/api/v1/stores/${storeId}/inventory/lookup?barcode=${encodeURIComponent(bc)}`
      );
      if (error || !data) {
        setLookupErr(scanErrorText(t, error, 'barcodeNotFound'));
      } else {
        setLookup(data);
      }
    },
    [storeId, t]
  );

  const handleBarcodeSubmit = useCallback(
    (bc: string) => {
      setBarcode(bc);
      setCameraOpen(false);
      doLookup(bc);
    },
    [doLookup]
  );

  const handleReceive = async () => {
    if (!lookup || qty <= 0) return;
    setSubmitting(true);
    setSubmitErr(null);
    const { data, error } = await apiPost<ReceiveResult>(
      `/api/v1/stores/${storeId}/inventory/receive`,
      { barcode: lookup.barcode, qty }
    );
    setSubmitting(false);
    if (error || !data) {
      setSubmitErr(scanErrorText(t, error, 'receiving.errorGeneric'));
    } else {
      setResult(data);
      setLookup(null);
      setBarcode('');
      setQty(1);
    }
  };

  return (
    <div className="space-y-4">
      {cameraOpen ? (
        <CameraScanner
          onDetected={handleBarcodeSubmit}
          onStop={() => setCameraOpen(false)}
          onError={msg => {
            setCameraError(msg);
            setCameraOpen(false);
          }}
        />
      ) : (
        <BarcodeInput
          value={barcode}
          onChange={setBarcode}
          onSubmit={handleBarcodeSubmit}
          placeholder={t('barcodeInputPlaceholder')}
          cameraSupported={cameraSupported}
          onOpenCamera={() => {
            setCameraOpen(true);
            setCameraError(null);
            setBarcode('');
          }}
          cameraError={cameraError}
          t={t}
        />
      )}

      {lookupErr && (
        <div className="rounded-lg bg-destructive/10 border border-destructive/30 px-4 py-3 text-sm text-destructive-ink">
          {lookupErr}
        </div>
      )}

      {lookup && (
        <div className="rounded-xl border border-border bg-card p-4 space-y-3">
          {lookup.ambiguous && <p className="text-xs text-amber-600">{t('ambiguousWarning')}</p>}
          <div>
            <p className="font-semibold text-sm">{lookup.productName}</p>
            {lookup.variantTitle && (
              <p className="text-xs text-muted-foreground">
                <VariantText title={lookup.variantTitle} />
              </p>
            )}
            <p className="text-xs text-muted-foreground mt-0.5">
              {lookup.sku ? t('skuLabel', { sku: lookup.sku }) : ''}
              {lookup.sku ? ' · ' : ''}
              {t('onHandLabel')} {lookup.inventory}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <label className="text-sm font-medium min-w-[4rem]">{t('qtyLabel')}</label>
            <input
              type="number"
              min={1}
              value={qty}
              onChange={e => setQty(Math.max(1, parseInt(e.target.value, 10) || 1))}
              className="w-24 min-h-[44px] rounded-lg border border-border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
          </div>
          <button
            type="button"
            onClick={handleReceive}
            disabled={submitting}
            className="min-h-[44px] w-full rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? '…' : t('submitReceive')}
          </button>
          {submitErr && <p className="text-xs text-destructive-ink">{submitErr}</p>}
        </div>
      )}

      {result && (
        <div className="rounded-xl border border-green-200 bg-green-50 p-4 text-sm text-green-800">
          {t('receiving.success', {
            qty: String(result.qtyReceived),
            name: '',
            newQty: String(result.newInventory),
          })}
          <p className="text-xs mt-1 text-green-700">
            {result.previousInventory} → {result.newInventory}
          </p>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-component: PickMode
// ─────────────────────────────────────────────────────────────────────────────
function PickMode({ storeId }: { storeId: string }) {
  const t = useT('stock.scan');
  const locale = useLocale();
  const cameraSupported = useBarcodeDetectorSupported();
  const [orderInput, setOrderInput] = useState('');
  const [order, setOrder] = useState<OrderPickProgress | null>(null);
  const [orderErr, setOrderErr] = useState<string | null>(null);
  const [orderLoading, setOrderLoading] = useState(false);
  const [barcode, setBarcode] = useState('');
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [pickResult, setPickResult] = useState<PickResult | null>(null);
  const [pickErr, setPickErr] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);

  const loadOrder = async () => {
    if (!orderInput.trim()) return;
    setOrderLoading(true);
    setOrderErr(null);
    setOrder(null);
    setPickResult(null);
    // Look up by order number. The list's `search` is a contains-match (it
    // was ignored by the API outright, so this used to open the store's
    // NEWEST order whatever was typed) — take the exact order-number match.
    const wanted = orderInput.trim();
    const { data, error } = await apiGet<{
      orders: { id: string; orderNumber: string }[];
      meta: { total: number };
    }>(`/api/v1/stores/${storeId}/orders?limit=20`, searchQueryHeaders(wanted));
    const match = data?.orders?.find(o => o.orderNumber.toLowerCase() === wanted.toLowerCase());
    if (error || !match) {
      setOrderErr(scanErrorText(t, error, 'orderNotFound'));
      setOrderLoading(false);
      return;
    }
    const orderId = match.id;
    const { data: progress, error: progErr } = await apiGet<OrderPickProgress>(
      `/api/v1/stores/${storeId}/inventory/orders/${orderId}/pick-progress`
    );
    setOrderLoading(false);
    if (progErr || !progress) {
      setOrderErr(scanErrorText(t, progErr, 'orderNotFound'));
    } else {
      setOrder(progress);
    }
  };

  const handlePickScan = useCallback(
    async (bc: string) => {
      if (!order) return;
      setCameraOpen(false);
      setBarcode(bc);
      setPickErr(null);
      setPickResult(null);
      setPicking(true);
      const { data, error } = await apiPost<PickResult>(
        `/api/v1/stores/${storeId}/inventory/orders/${order.orderId}/pick`,
        { barcode: bc, qty: 1 }
      );
      setPicking(false);
      if (error || !data) {
        setPickErr(scanErrorText(t, error, 'picking.itemNotFound'));
      } else {
        setPickResult(data);
        setBarcode('');
        // Refresh order progress
        const { data: progress } = await apiGet<OrderPickProgress>(
          `/api/v1/stores/${storeId}/inventory/orders/${order.orderId}/pick-progress`
        );
        if (progress) setOrder(progress);
      }
    },
    [order, storeId, t]
  );

  return (
    <div className="space-y-4">
      {/* Order loader */}
      {!order && (
        <div className="space-y-2">
          <div className="flex gap-2">
            <input
              type="text"
              value={orderInput}
              onChange={e => setOrderInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && loadOrder()}
              placeholder={t('orderNumberPlaceholder')}
              className="flex-1 min-h-[44px] rounded-lg border border-border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
              autoComplete="off"
            />
            <button
              type="button"
              onClick={loadOrder}
              disabled={orderLoading}
              className="min-h-[44px] px-4 rounded-lg bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50"
            >
              {orderLoading ? '…' : t('loadOrder')}
            </button>
          </div>
          {orderErr && <p className="text-sm text-destructive-ink">{orderErr}</p>}
        </div>
      )}

      {/* Order loaded — show items + barcode scanner */}
      {order && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-semibold text-sm">{order.orderNumber}</p>
              <p className="text-xs text-muted-foreground capitalize">{order.status}</p>
            </div>
            <div className="flex items-center gap-2">
              {order.fullyPicked && (
                <span className="inline-block px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800">
                  {t('picking.orderComplete')}
                </span>
              )}
              <button
                type="button"
                onClick={() => {
                  setOrder(null);
                  setOrderInput('');
                  setPickResult(null);
                }}
                className="text-xs text-muted-foreground underline"
              >
                {t('pickChangeOrder')}
              </button>
            </div>
          </div>

          {/* Item list */}
          <DataTable<OrderItem>
            ariaLabel={t('pickItemsTableLabel')}
            columns={[
              {
                header: t('colItem'),
                primaryOnMobile: true,
                cell: item => {
                  const done = item.pickedQty >= item.quantity;
                  return (
                    <div className={done ? 'opacity-60' : ''}>
                      <p className="font-medium">{item.productName}</p>
                      {orderLineVariantTitle(item, locale === 'ar') && (
                        <p className="text-xs text-muted-foreground">
                          <VariantText title={orderLineVariantTitle(item, locale === 'ar')!} />
                        </p>
                      )}
                      {item.personalisation && (
                        <p className="text-xs font-medium text-foreground">
                          ✎ <bdi>{item.personalisation}</bdi>
                        </p>
                      )}
                    </div>
                  );
                },
              },
              {
                header: t('colPicked'),
                alignEnd: true,
                className: 'w-20',
                cell: item => {
                  const done = item.pickedQty >= item.quantity;
                  return (
                    <span className={`font-mono text-xs ${done ? 'opacity-60' : ''}`}>
                      <span className={done ? 'text-green-700 font-semibold' : ''}>
                        {item.pickedQty}/{item.quantity}
                      </span>
                      {done && ' ✓'}
                    </span>
                  );
                },
              },
            ]}
            rows={order.items}
            rowKey={item => item.id}
          />

          {/* Barcode scanner */}
          {!order.fullyPicked && (
            <div className="space-y-3">
              {cameraOpen ? (
                <CameraScanner
                  onDetected={handlePickScan}
                  onStop={() => setCameraOpen(false)}
                  onError={msg => {
                    setCameraError(msg);
                    setCameraOpen(false);
                  }}
                />
              ) : (
                <BarcodeInput
                  value={barcode}
                  onChange={setBarcode}
                  onSubmit={handlePickScan}
                  placeholder={t('barcodeInputPlaceholder')}
                  cameraSupported={cameraSupported}
                  onOpenCamera={() => {
                    setCameraOpen(true);
                    setCameraError(null);
                    setBarcode('');
                  }}
                  disabled={picking}
                  cameraError={cameraError}
                  t={t}
                />
              )}

              {picking && <p className="text-xs text-muted-foreground">…</p>}

              {pickResult && (
                <div className="rounded-lg bg-green-50 border border-green-200 px-4 py-2 text-sm text-green-800">
                  {t('picking.success', {
                    qty: String(pickResult.pickedQtyAfter - pickResult.pickedQtyBefore),
                    name: pickResult.productName,
                    picked: String(pickResult.pickedQtyAfter),
                    total: String(pickResult.qtyOrdered),
                  })}
                </div>
              )}
              {pickErr && <p className="text-sm text-destructive-ink">{pickErr}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-component: CountMode
// ─────────────────────────────────────────────────────────────────────────────
function CountMode({ storeId }: { storeId: string }) {
  const t = useT('stock.scan');
  const tc = useT('common');
  const cameraSupported = useBarcodeDetectorSupported();
  const [sessions, setSessions] = useState<
    | { id: string; status: string; note: string | null; lineCount: number; createdAt: string }[]
    | null
  >(null);
  const [activeSession, setActiveSession] = useState<CountSession | null>(null);
  const [newNote, setNewNote] = useState('');
  const [sessionLoading, setSessionLoading] = useState(false);
  const [barcode, setBarcode] = useState('');
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [lookupResult, setLookupResult] = useState<LookupResult | null>(null);
  const [countQty, setCountQty] = useState(0);
  const [lineErr, setLineErr] = useState<string | null>(null);
  const [submittingLine, setSubmittingLine] = useState(false);
  const [reconcileResult, setReconcileResult] = useState<{
    adjustmentId: string | null;
    linesReconciled: number;
  } | null>(null);
  const [reconciling, setReconciling] = useState(false);
  const [reconcileErr, setReconcileErr] = useState<string | null>(null);

  // Load existing open sessions on mount
  useEffect(() => {
    if (!storeId) return;
    apiGet<
      { id: string; status: string; note: string | null; lineCount: number; createdAt: string }[]
    >(`/api/v1/stores/${storeId}/inventory/count-sessions?status=open`).then(({ data }) => {
      setSessions(data ?? []);
    });
  }, [storeId]);

  const loadSession = useCallback(
    async (sessionId: string) => {
      setSessionLoading(true);
      const { data } = await apiGet<CountSession>(
        `/api/v1/stores/${storeId}/inventory/count-sessions/${sessionId}`
      );
      setSessionLoading(false);
      if (data) setActiveSession(data);
    },
    [storeId]
  );

  const startSession = async () => {
    setSessionLoading(true);
    const { data } = await apiPost<{
      id: string;
      status: string;
      note: string | null;
      createdAt: string;
    }>(`/api/v1/stores/${storeId}/inventory/count-sessions`, { note: newNote || undefined });
    setSessionLoading(false);
    if (data) {
      await loadSession(data.id);
    }
  };

  const handleBarcodeForCount = useCallback(
    async (bc: string) => {
      setCameraOpen(false);
      setBarcode(bc);
      setLineErr(null);
      const { data, error } = await apiGet<LookupResult>(
        `/api/v1/stores/${storeId}/inventory/lookup?barcode=${encodeURIComponent(bc)}`
      );
      if (error || !data) {
        setLineErr(scanErrorText(t, error, 'barcodeNotFound'));
        setLookupResult(null);
      } else {
        setLookupResult(data);
        setCountQty(data.inventory); // Pre-fill with system qty as default
      }
    },
    [storeId, t]
  );

  const submitLine = async () => {
    if (!activeSession || !lookupResult) return;
    setSubmittingLine(true);
    setLineErr(null);
    const { data, error } = await apiPost<CountLine>(
      `/api/v1/stores/${storeId}/inventory/count-sessions/${activeSession.id}/lines`,
      {
        productId: lookupResult.productId,
        variantId: lookupResult.variantId,
        countedQty: countQty,
      }
    );
    setSubmittingLine(false);
    if (error || !data) {
      setLineErr(scanErrorText(t, error, 'counting.errorGeneric'));
    } else {
      // Refresh session
      await loadSession(activeSession.id);
      setBarcode('');
      setLookupResult(null);
      setCountQty(0);
    }
  };

  const closeSession = async () => {
    if (!activeSession) return;
    if (!confirm(t('counting.closeConfirm'))) return;
    const { data } = await apiPost<{ id: string; status: string }>(
      `/api/v1/stores/${storeId}/inventory/count-sessions/${activeSession.id}/close`,
      {}
    );
    if (data) await loadSession(activeSession.id);
  };

  const reconcile = async () => {
    if (!activeSession) return;
    if (!confirm(t('counting.reconcileConfirm'))) return;
    setReconciling(true);
    setReconcileErr(null);
    const { data, error } = await apiPost<{
      adjustmentId: string | null;
      linesReconciled: number;
      zeroVarianceLines: number;
    }>(`/api/v1/stores/${storeId}/inventory/count-sessions/${activeSession.id}/reconcile`, {});
    setReconciling(false);
    if (error || !data) {
      setReconcileErr(scanErrorText(t, error, 'counting.errorGeneric'));
    } else {
      setReconcileResult(data);
      await loadSession(activeSession.id);
    }
  };

  if (!sessions) {
    return <p className="text-sm text-muted-foreground">{tc('loading')}</p>;
  }

  // No active session chosen yet
  if (!activeSession) {
    return (
      <div className="space-y-4">
        {sessions.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm font-medium">{t('counting.openSession')}</p>
            {sessions.map(s => (
              <button
                key={s.id}
                type="button"
                onClick={() => loadSession(s.id)}
                className="w-full text-start rounded-xl border border-border bg-card p-4 hover:bg-muted/30 min-h-[44px]"
              >
                <p className="text-sm font-medium">{s.note || t('countSession')}</p>
                <p className="text-xs text-muted-foreground">
                  {new Date(s.createdAt).toLocaleString(undefined, withNumerals())} · {s.lineCount}{' '}
                  {t('linesSuffix')}
                </p>
              </button>
            ))}
            <div className="border-t border-border/40 pt-4" />
          </div>
        )}
        {sessions.length === 0 && (
          <p className="text-sm text-muted-foreground">{t('counting.noOpenSession')}</p>
        )}
        <div className="space-y-2">
          <p className="text-sm font-medium">{t('counting.newSession')}</p>
          <input
            type="text"
            value={newNote}
            onChange={e => setNewNote(e.target.value)}
            placeholder={t('counting.sessionNote')}
            className="w-full min-h-[44px] rounded-lg border border-border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
          <button
            type="button"
            onClick={startSession}
            disabled={sessionLoading}
            className="min-h-[44px] w-full rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50"
          >
            {sessionLoading ? '…' : t('counting.startSession')}
          </button>
        </div>
      </div>
    );
  }

  const sessionDone = activeSession.status === 'reconciled';

  return (
    <div className="space-y-4">
      {/* Session header */}
      <div className="flex items-center justify-between rounded-xl border border-border bg-card p-4">
        <div>
          <p className="text-sm font-medium">{activeSession.note || t('countSession')}</p>
          <p className="text-xs text-muted-foreground">
            {t('counting.sessionStatus', { status: activeSession.status })} ·{' '}
            {t('counting.linesCount', { count: String(activeSession.lines.length) })}
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setActiveSession(null);
            setReconcileResult(null);
          }}
          className="text-xs text-muted-foreground underline min-h-[44px] px-2"
        >
          {tc('close')}
        </button>
      </div>

      {/* Scan input (only when open) */}
      {activeSession.status === 'open' && (
        <div className="space-y-3">
          {cameraOpen ? (
            <CameraScanner
              onDetected={handleBarcodeForCount}
              onStop={() => setCameraOpen(false)}
              onError={msg => {
                setCameraError(msg);
                setCameraOpen(false);
              }}
            />
          ) : (
            <BarcodeInput
              value={barcode}
              onChange={setBarcode}
              onSubmit={handleBarcodeForCount}
              placeholder={t('barcodeInputPlaceholder')}
              cameraSupported={cameraSupported}
              onOpenCamera={() => {
                setCameraOpen(true);
                setCameraError(null);
                setBarcode('');
              }}
              cameraError={cameraError}
              t={t}
            />
          )}

          {lineErr && <p className="text-sm text-destructive-ink">{lineErr}</p>}

          {lookupResult && (
            <div className="rounded-xl border border-border bg-card p-4 space-y-3">
              <div>
                <p className="font-semibold text-sm">{lookupResult.productName}</p>
                {lookupResult.variantTitle && (
                  <p className="text-xs text-muted-foreground">
                    <VariantText title={lookupResult.variantTitle} />
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  {t('systemQtyLabel')} {lookupResult.inventory}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <label className="text-sm font-medium min-w-[5rem]">{t('counting.counted')}</label>
                <input
                  type="number"
                  min={0}
                  value={countQty}
                  onChange={e => setCountQty(Math.max(0, parseInt(e.target.value, 10) || 0))}
                  className="w-24 min-h-[44px] rounded-lg border border-border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                />
              </div>
              <button
                type="button"
                onClick={submitLine}
                disabled={submittingLine}
                className="min-h-[44px] w-full rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50"
              >
                {submittingLine ? '…' : t('counting.submitLine')}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Lines table */}
      {activeSession.lines.length > 0 && (
        <DataTable<CountLine>
          ariaLabel={t('countLinesTableLabel')}
          columns={[
            {
              header: t('colItem'),
              primaryOnMobile: true,
              cell: line => (
                <>
                  <p className="font-medium text-xs">{line.productName}</p>
                  {line.variantTitle && (
                    <p className="text-xs text-muted-foreground">
                      <VariantText title={line.variantTitle} />
                    </p>
                  )}
                </>
              ),
            },
            {
              header: t('counting.counted'),
              alignEnd: true,
              className: 'w-20',
              cell: line => <span className="font-mono text-xs">{line.countedQty}</span>,
            },
            {
              header: t('counting.system'),
              alignEnd: true,
              className: 'w-20',
              cell: line => <span className="font-mono text-xs">{line.systemQty}</span>,
            },
            {
              header: t('counting.variance'),
              alignEnd: true,
              className: 'w-20',
              cell: line => (
                <span
                  className={`font-mono text-xs font-semibold ${
                    line.variance > 0
                      ? 'text-green-700'
                      : line.variance < 0
                        ? 'text-red-600'
                        : 'text-muted-foreground'
                  }`}
                >
                  {line.variance > 0 ? `+${line.variance}` : line.variance}
                </span>
              ),
            },
          ]}
          rows={activeSession.lines}
          rowKey={line => line.id}
        />
      )}

      {/* Actions */}
      {!sessionDone && (
        <div className="flex gap-3">
          {activeSession.status === 'open' && (
            <button
              type="button"
              onClick={closeSession}
              className="flex-1 min-h-[44px] rounded-lg border border-border bg-background text-sm font-medium hover:bg-muted/30"
            >
              {t('counting.closeSession')}
            </button>
          )}
          {activeSession.status === 'closed' && (
            <button
              type="button"
              onClick={reconcile}
              disabled={reconciling}
              className="flex-1 min-h-[44px] rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50"
            >
              {reconciling ? '…' : t('counting.reconcile')}
            </button>
          )}
        </div>
      )}

      {reconcileErr && <p className="text-sm text-destructive-ink">{reconcileErr}</p>}

      {reconcileResult && (
        <div className="rounded-lg bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-800">
          {reconcileResult.adjustmentId
            ? t('counting.reconciled', { id: reconcileResult.adjustmentId.slice(0, 8) + '…' })
            : t('counting.noVariances')}
          <p className="text-xs mt-1 text-green-700">
            {t('linesAdjusted', { count: reconcileResult.linesReconciled })}
          </p>
        </div>
      )}

      {sessionDone && (
        <div className="rounded-lg bg-muted/30 border border-border px-4 py-3 text-sm text-muted-foreground">
          {t('sessionReconciledOn', {
            date: activeSession.reconciledAt
              ? new Date(activeSession.reconciledAt).toLocaleString(undefined, withNumerals())
              : '—',
          })}
          {activeSession.adjustmentId && (
            <p className="text-xs mt-1">
              {t('adjustmentLabel')} {activeSession.adjustmentId.slice(0, 8)}…
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Page
// ─────────────────────────────────────────────────────────────────────────────

export default function BarcodeScanPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const t = useT('stock.scan');
  const [mode, setMode] = useState<Mode>('receive');
  // Every inventory/* endpoint this page calls is requireFeature('inventory.barcode'): without it
  // the scanner would draw fully and never work (count mode's lists and "start session" fail
  // silently). Gate the whole page; scanErrorText stays as the backstop for a mid-session change.
  const { isEnabled, isLoading: featuresLoading } = useFeatures();
  const barcodeEnabled = isEnabled('inventory.barcode');

  const modes: { key: Mode; label: string }[] = [
    { key: 'receive', label: t('modeReceive') },
    { key: 'pick', label: t('modePick') },
    { key: 'count', label: t('modeCount') },
  ];

  return (
    <AdminLayout title={t('title')} subtitle={t('description')}>
      {featuresLoading ? (
        <div className="max-w-lg mx-auto space-y-3" data-testid="scan-features-skeleton">
          <div className="h-12 animate-pulse rounded-xl bg-muted/40" />
          <div className="h-32 animate-pulse rounded-xl bg-muted/30" />
        </div>
      ) : !barcodeEnabled ? (
        <div
          role="status"
          data-testid="scan-feature-off"
          className="max-w-lg mx-auto rounded-xl border border-border bg-muted/20 p-5 text-sm leading-relaxed text-foreground"
        >
          {t('featureNotOnPlan')}
        </div>
      ) : (
        <div className="max-w-lg mx-auto space-y-5">
          {/* Mode selector */}
          <div className="flex rounded-xl border border-border bg-muted/20 p-1 gap-1">
            {modes.map(m => (
              <button
                key={m.key}
                type="button"
                onClick={() => setMode(m.key)}
                className={[
                  'flex-1 min-h-[44px] rounded-lg text-sm font-medium transition-colors',
                  mode === m.key
                    ? 'bg-background shadow-sm text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                ].join(' ')}
              >
                {m.label}
              </button>
            ))}
          </div>

          {/* What this page does — bilingual explainer of the 3 modes */}
          <div className="rounded-xl border border-border bg-muted/20 p-3 text-xs leading-relaxed text-muted-foreground space-y-1.5">
            <p className="font-semibold text-foreground">{t('helpTitle')}</p>
            <p>
              <span className="font-medium text-foreground">{t('modeReceive')}:</span>{' '}
              {t('helpReceive')}
            </p>
            <p>
              <span className="font-medium text-foreground">{t('modePick')}:</span> {t('helpPick')}
            </p>
            <p>
              <span className="font-medium text-foreground">{t('modeCount')}:</span>{' '}
              {t('helpCount')}
            </p>
            <p className="pt-1 border-t border-border/60">{t('helpCamera')}</p>
          </div>

          {/* Mode content */}
          {mode === 'receive' && <ReceiveMode storeId={storeId} />}
          {mode === 'pick' && <PickMode storeId={storeId} />}
          {mode === 'count' && <CountMode storeId={storeId} />}
        </div>
      )}
    </AdminLayout>
  );
}
