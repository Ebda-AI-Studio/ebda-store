'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, useToast } from '@ebda/ui';
import { api } from '@/lib/api';
import { useCart } from '../../contexts/CartContext';
import { useLanguage } from '../../contexts/LanguageContext';
import { useNumerals } from '../../hooks/useNumerals';
import { useStoreUrl } from '../../contexts/StoreContext';
import { countText, ITEMS_ADDED, ITEMS_UNAVAILABLE } from '../../lib/plural';
import { reorderLines } from './reorder-lines';

/**
 * "Order again" on an order's page (Phase B4, Lamma; Ruling B4-8). Puts every line that can still
 * be bought back in the cart through the normal add path (the server re-checks stock, variant and
 * personalisation on every add; this never reads or edits the old order), then says in ONE
 * sentence how many could not go back and why. At least one line added: the shopper lands on the
 * cart. Nothing added: they stay here and the sentence says so.
 */
export function ReorderOrderButton({
  items,
  className,
}: {
  items: Parameters<typeof reorderLines>[0];
  className?: string;
}) {
  const { refetchCart } = useCart();
  const { language, t } = useLanguage();
  const { localize } = useNumerals();
  const { info, success } = useToast();
  const router = useRouter();
  const storeUrl = useStoreUrl();
  const [busy, setBusy] = useState(false);
  const lines = reorderLines(items);
  if (lines.length === 0) return null;
  const lang = language === 'ar' ? 'ar' : 'en';

  const run = async () => {
    setBusy(true);
    let added = 0;
    let skipped = 0;
    for (const l of lines) {
      try {
        const res = await api.addToCart(l.productId, l.quantity, l.variantId, l.note);
        if (res.success) added++;
        else skipped++;
      } catch {
        skipped++;
      }
    }
    await refetchCart().catch(() => {});
    setBusy(false);
    const skippedText = skipped
      ? t(
          `Could not add: ${countText(lang, skipped, ITEMS_UNAVAILABLE, localize(skipped))}.`,
          `تعذّرت الإضافة: ${countText(lang, skipped, ITEMS_UNAVAILABLE, localize(skipped))}.`
        )
      : '';
    if (added > 0) {
      success(countText(lang, added, ITEMS_ADDED, localize(added)), skippedText || undefined);
      router.push(storeUrl('/cart'));
    } else {
      info(t('Nothing was added', 'متضافش حاجة'), skippedText || undefined);
    }
  };

  return (
    <Button
      type="button"
      variant="outline"
      onClick={() => (busy ? undefined : run())}
      aria-disabled={busy || undefined}
      aria-busy={busy || undefined}
      className={className ?? 'min-h-11 self-start'}
    >
      {t('Reorder', 'إعادة الطلب')}
    </Button>
  );
}
