'use client';

/**
 * BotCopyTab — Phase 2 bot intelligence.
 *
 * Lets merchants edit the text their WhatsApp ordering bot sends to customers.
 * Each row shows: key name, available variables, a read-only canonical default
 * (italic/gray placeholder), and an EN + AR textarea for overrides.
 *
 * Saves the full botCopy map via PUT /stores/:id/integrations/wbs.
 * Canonical defaults live in WBS botCopyDefaults.js — this tab mirrors them
 * so the merchant can see exactly what the bot would say by default.
 *
 * Reset-to-default per key: clears that key from the overrides map.
 */

import { useState, useEffect, useCallback } from 'react';
import { Button, useToast } from '@force/ui';
import { apiGet, apiPut } from '../../lib/api';

// ─── Canonical defaults (mirror of WBS botCopyDefaults.js) ───────────────────
// These are the out-of-the-box bot messages shipped with the WBS service.
// They are duplicated here so the admin can render placeholder text for each
// key without an extra network round-trip to the WBS service.
//
// MAINTENANCE NOTE (BUG-COPY-01): The WBS `GET /integrations/wbs` endpoint
// does not yet expose these canonical defaults. When WBS adds a
// `canonicalBotCopy` field to that response, wire it here instead:
//   const [canonicalDefaults, setCanonicalDefaults] = useState(CANONICAL_DEFAULTS);
//   // in fetchConfig: if (data?.canonicalBotCopy) setCanonicalDefaults(data.canonicalBotCopy);
// Until then, update this constant when WBS botCopyDefaults.js changes.

const CANONICAL_DEFAULTS: Record<string, { en: string; ar: string }> = {
  catalog_preparing: {
    en: 'Hello! Our catalog is being prepared. Please try again later.',
    ar: 'مرحبا! منتجاتنا قيد التحضير. يرجى المحاولة لاحقا.',
  },
  welcome_header: { en: 'Welcome 👋', ar: 'مرحبا 👋' },
  welcome_body: {
    en: 'Browse our catalog by category:',
    ar: 'تصفح منتجاتنا حسب الفئة:',
  },
  welcome_button_text: { en: 'Categories', ar: 'الفئات' },
  welcome_footer: {
    en: 'Or send a product name to search.',
    ar: 'أو اكتب اسم منتج للبحث.',
  },
  categories_section_title: { en: 'Categories', ar: 'الفئات' },
  no_products: {
    en: 'No products in that category right now.',
    ar: 'لا توجد منتجات في هذه الفئة حاليا.',
  },
  products_body: {
    en: 'Tap a product to add it to your cart:',
    ar: 'اضغط على منتج لإضافته إلى السلة:',
  },
  products_button_text: { en: 'Products', ar: 'المنتجات' },
  products_section_title: { en: 'Products', ar: 'المنتجات' },
  products_more_footer: {
    en: 'Reply "more" for the next page.',
    ar: 'اكتب "المزيد" للصفحة التالية.',
  },
  out_of_stock: { en: ' · OUT OF STOCK', ar: ' · غير متوفر' },
  product_out_of_stock: {
    en: 'That item is out of stock — please pick another.',
    ar: 'هذا المنتج غير متوفر — يرجى اختيار غيره.',
  },
  add_to_cart_body: {
    en: 'Add *{name}* ({price}) to cart. How many?',
    ar: 'إضافة *{name}* ({price}) إلى السلة. كم العدد؟',
  },
  qty_1: { en: '1', ar: '١' },
  qty_2: { en: '2', ar: '٢' },
  qty_more: { en: 'More…', ar: 'أكثر…' },
  qty_prompt: {
    en: 'How many? Type a number (e.g. 5).',
    ar: 'كم العدد؟ اكتب رقما (مثلا ٥).',
  },
  qty_range: {
    en: 'Please send a number between 1 and 99.',
    ar: 'يرجى إرسال رقم بين ١ و ٩٩.',
  },
  cart_updated: {
    en: '✅ Added *{qty} × {name}* to your cart.\n\nCart total: {total}\n\nAdd more or checkout?',
    ar: '✅ تمت إضافة *{qty} × {name}* إلى السلة.\n\nإجمالي السلة: {total}\n\nإضافة المزيد أم إتمام الطلب؟',
  },
  btn_add_more: { en: 'Add more', ar: 'إضافة المزيد' },
  btn_checkout: { en: 'Checkout', ar: 'إتمام الطلب' },
  btn_cancel: { en: 'Cancel', ar: 'إلغاء' },
  cart_cleared: {
    en: 'No problem — your cart has been cleared. Send a message any time to start a new order.',
    ar: 'تم إلغاء السلة. أرسل رسالة في أي وقت لبدء طلب جديد.',
  },
  checkout_unavailable: {
    en: 'Sorry, checkout is unavailable right now. A team member will reach out.',
    ar: 'عذرا، الطلب غير متاح حاليا. سيتواصل معك أحد فريقنا.',
  },
  checkout_error: {
    en: "Sorry, we couldn't create your order: {error}. A team member will follow up.",
    ar: 'عذرا، تعذر إنشاء طلبك: {error}. سيتابع أحد فريقنا معك.',
  },
  checkout_ready: {
    en: '🛒 *Your order is ready!*\n\nComplete your purchase here:\n{url}\n\nThis link expires in 30 minutes.',
    ar: '🛒 *طلبك جاهز!*\n\nأتمم الطلب من هنا:\n{url}\n\nالرابط صالح لمدة 30 دقيقة.',
  },
  checkout_resend: {
    en: 'Your checkout link: {url}\n\nA team member will follow up if you need help.',
    ar: 'رابط الطلب: {url}\n\nسيتابع أحد فريقنا معك إذا احتجت أي مساعدة.',
  },
  search_found_n: {
    en: 'Found {count} matches for "{query}":',
    ar: '{count} نتائج لـ "{query}":',
  },
  search_no_results: {
    en: 'No matching products. Try a different name or pick a category.',
    ar: 'لا توجد منتجات مطابقة. جرب اسما آخر أو اختر فئة.',
  },
  search_section_title: { en: 'Results', ar: 'النتائج' },
  tap_a_product: {
    en: 'Please tap a product from the list above.',
    ar: 'يرجى اختيار منتج من القائمة أعلاه.',
  },
  tap_a_flow_button: {
    en: 'Tap "Add more" or "Checkout" to continue.',
    ar: 'اضغط "إضافة المزيد" أو "إتمام الطلب" للمتابعة.',
  },
};

// ─── Key metadata (display name + available variables) ───────────────────────

interface KeyMeta {
  label: string;
  labelAr: string;
  group: string;
  vars?: string;
}

const KEY_META: Record<string, KeyMeta> = {
  catalog_preparing: { label: 'Catalog preparing', labelAr: 'التحضير', group: 'Greeting' },
  welcome_header: { label: 'Welcome header', labelAr: 'الترحيب', group: 'Greeting' },
  welcome_body: {
    label: 'Welcome body',
    labelAr: 'نص الترحيب',
    group: 'Greeting',
    vars: '{storeName}',
  },
  welcome_button_text: { label: 'Categories button', labelAr: 'زر الفئات', group: 'Greeting' },
  welcome_footer: { label: 'Welcome footer', labelAr: 'تذييل الترحيب', group: 'Greeting' },
  categories_section_title: {
    label: 'Categories section title',
    labelAr: 'عنوان الفئات',
    group: 'Greeting',
  },
  no_products: { label: 'No products message', labelAr: 'لا توجد منتجات', group: 'Products' },
  products_body: { label: 'Products list body', labelAr: 'قائمة المنتجات', group: 'Products' },
  products_button_text: { label: 'Products button', labelAr: 'زر المنتجات', group: 'Products' },
  products_section_title: {
    label: 'Products section title',
    labelAr: 'عنوان المنتجات',
    group: 'Products',
  },
  products_more_footer: {
    label: 'More products footer',
    labelAr: 'المزيد من المنتجات',
    group: 'Products',
  },
  out_of_stock: { label: 'Out-of-stock badge', labelAr: 'نفذ المخزون', group: 'Products' },
  product_out_of_stock: {
    label: 'Product out of stock message',
    labelAr: 'رسالة نفاد المخزون',
    group: 'Products',
  },
  add_to_cart_body: {
    label: 'Add-to-cart message',
    labelAr: 'رسالة الإضافة للسلة',
    group: 'Cart',
    vars: '{name} {price}',
  },
  qty_1: { label: 'Qty button: 1', labelAr: 'زر الكمية ١', group: 'Cart' },
  qty_2: { label: 'Qty button: 2', labelAr: 'زر الكمية ٢', group: 'Cart' },
  qty_more: { label: 'Qty button: more', labelAr: 'زر الكمية أكثر', group: 'Cart' },
  qty_prompt: { label: 'Quantity prompt', labelAr: 'طلب الكمية', group: 'Cart' },
  qty_range: { label: 'Quantity range error', labelAr: 'خطأ نطاق الكمية', group: 'Cart' },
  cart_updated: {
    label: 'Cart updated',
    labelAr: 'تحديث السلة',
    group: 'Cart',
    vars: '{qty} {name} {total} {currency}',
  },
  btn_add_more: { label: 'Add more button', labelAr: 'زر إضافة المزيد', group: 'Cart' },
  btn_checkout: { label: 'Checkout button', labelAr: 'زر إتمام الطلب', group: 'Cart' },
  btn_cancel: { label: 'Cancel button', labelAr: 'زر الإلغاء', group: 'Cart' },
  cart_cleared: { label: 'Cart cleared message', labelAr: 'رسالة مسح السلة', group: 'Cart' },
  checkout_unavailable: {
    label: 'Checkout unavailable',
    labelAr: 'الدفع غير متاح',
    group: 'Checkout',
  },
  checkout_error: {
    label: 'Checkout error',
    labelAr: 'خطأ في الدفع',
    group: 'Checkout',
    vars: '{error}',
  },
  checkout_ready: {
    label: 'Checkout ready',
    labelAr: 'رابط الدفع جاهز',
    group: 'Checkout',
    vars: '{url}',
  },
  checkout_resend: {
    label: 'Checkout resend',
    labelAr: 'إعادة إرسال الرابط',
    group: 'Checkout',
    vars: '{url}',
  },
  search_found_n: {
    label: 'Search found results',
    labelAr: 'نتائج البحث',
    group: 'Search',
    vars: '{count} {query}',
  },
  search_no_results: { label: 'Search no results', labelAr: 'لا نتائج', group: 'Search' },
  search_section_title: { label: 'Search section title', labelAr: 'عنوان البحث', group: 'Search' },
  tap_a_product: { label: 'Tap a product prompt', labelAr: 'اختر منتجا', group: 'Prompts' },
  tap_a_flow_button: { label: 'Tap a flow button prompt', labelAr: 'اختر زرا', group: 'Prompts' },
};

const GROUPS = ['Greeting', 'Products', 'Cart', 'Checkout', 'Search', 'Prompts'];

// ─── Types ────────────────────────────────────────────────────────────────────

type BotCopyOverrides = Record<string, { en?: string; ar?: string }>;

// ─── Component ────────────────────────────────────────────────────────────────

export function BotCopyTab({ storeId }: { storeId: string }) {
  const { success: toastSuccess, error: toastError } = useToast();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [overrides, setOverrides] = useState<BotCopyOverrides>({});

  // ── Load current overrides ────────────────────────────────────────────────

  const fetchConfig = useCallback(async () => {
    if (!storeId) return;
    setLoading(true);
    const { data } = await apiGet<{ botCopy: BotCopyOverrides | null }>(
      `/api/v1/stores/${storeId}/integrations/wbs`
    );
    if (data?.botCopy) {
      setOverrides(data.botCopy);
    } else {
      setOverrides({});
    }
    setLoading(false);
  }, [storeId]);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  // ── Helpers ───────────────────────────────────────────────────────────────

  const setLocaleOverride = (key: string, locale: 'en' | 'ar', value: string) => {
    setOverrides(prev => {
      const existing = prev[key] ?? {};
      if (value.trim() === '') {
        // Empty = remove this locale's override. If both locales are now empty, remove the key.
        const updated = { ...existing };
        delete updated[locale];
        if (Object.keys(updated).length === 0) {
          const next = { ...prev };
          delete next[key];
          return next;
        }
        return { ...prev, [key]: updated };
      }
      return { ...prev, [key]: { ...existing, [locale]: value } };
    });
  };

  const resetKey = (key: string) => {
    setOverrides(prev => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const hasOverride = (key: string) =>
    Boolean(overrides[key]?.en?.trim() || overrides[key]?.ar?.trim());

  // ── Save ──────────────────────────────────────────────────────────────────

  const handleSave = async () => {
    setSaving(true);
    try {
      // Only send keys that have at least one non-empty override
      const payload: BotCopyOverrides = {};
      for (const [key, val] of Object.entries(overrides)) {
        const cleaned: { en?: string; ar?: string } = {};
        if (val.en?.trim()) cleaned.en = val.en.trim();
        if (val.ar?.trim()) cleaned.ar = val.ar.trim();
        if (Object.keys(cleaned).length > 0) payload[key] = cleaned;
      }
      const { error } = await apiPut(`/api/v1/stores/${storeId}/integrations/wbs`, {
        botCopy: Object.keys(payload).length > 0 ? payload : null,
      });
      if (error) {
        toastError('Save failed', error.message || 'Could not save bot copy settings');
      } else {
        toastSuccess('Bot copy saved', 'Your bot wording overrides are now live.');
        await fetchConfig();
      }
    } catch {
      toastError('Save failed', 'An unexpected error occurred');
    } finally {
      setSaving(false);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center h-48">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  const allKeys = Object.keys(KEY_META);
  const overrideCount = allKeys.filter(hasOverride).length;

  return (
    <div className="max-w-4xl space-y-6">
      {/* Header */}
      <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="font-medium text-foreground">Bot Copy Editor</h3>
            <p className="text-sm text-muted-foreground mt-1">
              Customize the wording your WhatsApp ordering bot uses when talking to customers. Leave
              a field blank to use the canonical default (shown as placeholder text).
            </p>
            {overrideCount > 0 && (
              <p className="text-xs text-primary mt-1.5 font-medium">
                {overrideCount} of {allKeys.length} messages customized
              </p>
            )}
          </div>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save changes'}
          </Button>
        </div>

        {/* Variable legend */}
        <div className="mt-4 rounded-lg bg-muted/40 px-4 py-3 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Variables</span> — use{' '}
          <code className="font-mono bg-background rounded px-1 py-0.5">{'{variableName}'}</code>{' '}
          syntax in your text.{' '}
          <span className="font-mono">
            {'{storeName}'} {'{name}'} {'{price}'} {'{qty}'} {'{total}'} {'{currency}'} {'{url}'}{' '}
            {'{error}'} {'{count}'} {'{query}'}
          </span>{' '}
          are supported per message (see label next to each row).
        </div>
      </div>

      {/* Groups */}
      {GROUPS.map(group => {
        const groupKeys = allKeys.filter(k => KEY_META[k]?.group === group);
        if (groupKeys.length === 0) return null;

        return (
          <div
            key={group}
            className="rounded-xl border border-border bg-card shadow-sm overflow-hidden"
          >
            {/* Group heading */}
            <div className="px-5 py-3 border-b border-border bg-muted/30">
              <h4 className="text-sm font-semibold text-foreground">{group}</h4>
            </div>

            <div className="divide-y divide-border">
              {groupKeys.map(key => {
                const meta = KEY_META[key];
                const canonical = CANONICAL_DEFAULTS[key];
                const overrideEn = overrides[key]?.en ?? '';
                const overrideAr = overrides[key]?.ar ?? '';
                const isOverridden = hasOverride(key);

                return (
                  <div key={key} className="px-5 py-4 space-y-3">
                    {/* Row header */}
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <span className="text-sm font-medium text-foreground">{meta?.label}</span>
                        {meta?.vars && (
                          <span className="ml-2 text-xs text-muted-foreground font-mono">
                            {meta.vars}
                          </span>
                        )}
                        {isOverridden && (
                          <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-primary/10 text-primary">
                            customized
                          </span>
                        )}
                      </div>
                      {isOverridden && (
                        <button
                          type="button"
                          onClick={() => resetKey(key)}
                          className="text-xs text-muted-foreground hover:text-red-500 transition-colors shrink-0"
                        >
                          Reset to default
                        </button>
                      )}
                    </div>

                    {/* EN + AR editors side by side */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {/* English */}
                      <div className="space-y-1">
                        <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                          EN
                        </label>
                        <textarea
                          rows={canonical?.en?.includes('\n') ? 4 : 2}
                          value={overrideEn}
                          onChange={e => setLocaleOverride(key, 'en', e.target.value)}
                          placeholder={canonical?.en ?? ''}
                          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 placeholder:italic focus:outline-none focus:ring-2 focus:ring-primary resize-none"
                        />
                      </div>

                      {/* Arabic */}
                      <div className="space-y-1">
                        <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                          AR
                        </label>
                        <textarea
                          rows={canonical?.ar?.includes('\n') ? 4 : 2}
                          dir="rtl"
                          value={overrideAr}
                          onChange={e => setLocaleOverride(key, 'ar', e.target.value)}
                          placeholder={canonical?.ar ?? ''}
                          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 placeholder:italic focus:outline-none focus:ring-2 focus:ring-primary resize-none"
                        />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      {/* Bottom save */}
      <div className="flex justify-end pb-6">
        <Button onClick={handleSave} disabled={saving}>
          {saving ? 'Saving…' : 'Save changes'}
        </Button>
      </div>
    </div>
  );
}
