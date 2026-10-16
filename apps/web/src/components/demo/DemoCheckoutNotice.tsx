'use client';

import { useLanguage } from '../../contexts/LanguageContext';

/**
 * Replaces the pay action on a demo store. The server refuses the order regardless
 * (`DEMO_STORE` 403 in `assertOrderAllowed`); this is the honest UI for it.
 */
export function DemoCheckoutNotice() {
  const { t } = useLanguage();
  return (
    <p
      role="status"
      data-demo-checkout-notice
      className="rounded-lg border border-dashed bg-muted/40 px-4 py-3 text-sm font-medium text-foreground"
    >
      {t('This is a demo store — ordering is closed', 'هذا متجر تجريبي — الطلبات مغلقة')}
    </p>
  );
}
