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
import { Button, useToast } from '@ebda/ui';
import { apiGet, apiPut } from '../../lib/api';
import { useT } from '../../i18n/useT';

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

// ─── Key metadata (available variables + group; display label comes from
// i18n via `keys.<key>` in the whatsappIntegration.botCopy namespace so it
// follows the admin's locale) ─────────────────────────────────────────────

interface KeyMeta {
  group: string;
  vars?: string;
}

const KEY_META: Record<string, KeyMeta> = {
  catalog_preparing: { group: 'greeting' },
  welcome_header: { group: 'greeting' },
  welcome_body: { group: 'greeting', vars: '{storeName}' },
  welcome_button_text: { group: 'greeting' },
  welcome_footer: { group: 'greeting' },
  categories_section_title: { group: 'greeting' },
  no_products: { group: 'products' },
  products_body: { group: 'products' },
  products_button_text: { group: 'products' },
  products_section_title: { group: 'products' },
  products_more_footer: { group: 'products' },
  out_of_stock: { group: 'products' },
  product_out_of_stock: { group: 'products' },
  add_to_cart_body: { group: 'cart', vars: '{name} {price}' },
  qty_1: { group: 'cart' },
  qty_2: { group: 'cart' },
  qty_more: { group: 'cart' },
  qty_prompt: { group: 'cart' },
  qty_range: { group: 'cart' },
  cart_updated: { group: 'cart', vars: '{qty} {name} {total} {currency}' },
  btn_add_more: { group: 'cart' },
  btn_checkout: { group: 'cart' },
  btn_cancel: { group: 'cart' },
  cart_cleared: { group: 'cart' },
  checkout_unavailable: { group: 'checkout' },
  checkout_error: { group: 'checkout', vars: '{error}' },
  checkout_ready: { group: 'checkout', vars: '{url}' },
  checkout_resend: { group: 'checkout', vars: '{url}' },
  search_found_n: { group: 'search', vars: '{count} {query}' },
  search_no_results: { group: 'search' },
  search_section_title: { group: 'search' },
  tap_a_product: { group: 'prompts' },
  tap_a_flow_button: { group: 'prompts' },
};

const GROUPS = ['greeting', 'products', 'cart', 'checkout', 'search', 'prompts'];

// ─── Types ────────────────────────────────────────────────────────────────────

type BotCopyOverrides = Record<string, { en?: string; ar?: string }>;

// ─── Component ────────────────────────────────────────────────────────────────

export function BotCopyTab({ storeId }: { storeId: string }) {
  const t = useT('whatsappIntegration.botCopy');
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
        toastError(t('saveFailedTitle'), error.message || t('saveFailedBody'));
      } else {
        toastSuccess(t('savedTitle'), t('savedBody'));
        await fetchConfig();
      }
    } catch {
      toastError(t('saveFailedTitle'), t('saveFailedGeneric'));
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
            <h3 className="font-medium text-foreground">{t('editorTitle')}</h3>
            <p className="text-sm text-muted-foreground mt-1">{t('editorDescription')}</p>
            {overrideCount > 0 && (
              <p className="text-xs text-primary mt-1.5 font-medium">
                {t('customizedCount', { count: overrideCount, total: allKeys.length })}
              </p>
            )}
          </div>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? t('saving') : t('saveChanges')}
          </Button>
        </div>

        {/* Variable legend */}
        <div className="mt-4 rounded-lg bg-muted/40 px-4 py-3 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{t('variablesLegendLabel')}</span>{' '}
          {t.rich('variablesLegendText', {
            code: chunks => (
              <code className="font-mono bg-background rounded px-1 py-0.5">
                {'{'}
                {chunks}
                {'}'}
              </code>
            ),
          })}{' '}
          <span className="font-mono">
            {'{storeName}'} {'{name}'} {'{price}'} {'{qty}'} {'{total}'} {'{currency}'} {'{url}'}{' '}
            {'{error}'} {'{count}'} {'{query}'}
          </span>{' '}
          {t('variablesLegendSupported')}
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
              <h4 className="text-sm font-semibold text-foreground">
                {t(`groups.${group}` as Parameters<typeof t>[0])}
              </h4>
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
                        <span className="text-sm font-medium text-foreground">
                          {t(`keys.${key}` as Parameters<typeof t>[0])}
                        </span>
                        {meta?.vars && (
                          <span className="ml-2 text-xs text-muted-foreground font-mono">
                            {meta.vars}
                          </span>
                        )}
                        {isOverridden && (
                          <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-primary/10 text-primary-ink">
                            {t('customizedBadge')}
                          </span>
                        )}
                      </div>
                      {isOverridden && (
                        <button
                          type="button"
                          onClick={() => resetKey(key)}
                          className="text-xs text-muted-foreground hover:text-red-500 transition-colors shrink-0"
                        >
                          {t('resetToDefault')}
                        </button>
                      )}
                    </div>

                    {/* EN + AR editors side by side */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {/* English */}
                      <div className="space-y-1">
                        <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                          {t('enColumnLabel')}
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
                          {t('arColumnLabel')}
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
          {saving ? t('saving') : t('saveChanges')}
        </Button>
      </div>
    </div>
  );
}
