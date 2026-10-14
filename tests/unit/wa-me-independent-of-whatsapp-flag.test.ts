/**
 * WHATSAPP-OFF-1: plain wa.me features need no WhatsApp API, so none of them may
 * depend on the `whatsapp` feature flag (which is OFF for every store). Guards
 * every wa.me surface: storefront contact + footer buttons, floating widget,
 * product share row, COD confirm, admin "message customer", payment-link share
 * (wa.me), setup-guide / onboarding share, the order-email wa.me block and the
 * marketing-site contact button.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');

const WA_ME_SURFACES = [
  'packages/shared/src/whatsapp/wa-me.ts',
  'packages/shared/src/whatsapp/wa-me-messages.ts',
  'apps/web/src/templates/shared/WaMeButtons.tsx',
  'apps/web/src/templates/shared/FloatingWidget.tsx',
  'apps/web/src/templates/shared/ShareProductRow.tsx',
  'apps/web/src/templates/classic/Footer.tsx',
  'apps/web/src/templates/modern/Footer.tsx',
  'apps/web/src/components/ShopChrome.tsx',
  'apps/admin/src/app/stores/[id]/branding/_components/ContactInfoTab.tsx',
  'apps/admin/src/app/stores/[id]/floating-widget/page.tsx',
  'apps/admin/src/app/stores/[id]/orders/[orderId]/_components/useMessageCustomer.ts',
  'apps/admin/src/app/stores/[id]/orders/[orderId]/_components/CustomerCard.tsx',
  'apps/admin/src/app/stores/[id]/orders/[orderId]/_components/PaymentLinkButton.tsx',
  'apps/orders/src/app/orders/[orderId]/_components/PaymentLinkButton.tsx',
  'apps/admin/src/app/onboarding/_components/LiveStep.tsx',
  'apps/api/src/services/email-templates/_wa-me.ts',
  'apps/marketing/src/components/WhatsApp.tsx',
];

// Anything that reads the `whatsapp` FEATURE (not the `whatsapp` social/contact field).
const FEATURE_FLAG_READ = [
  /requireFeature\(\s*['"]whatsapp['"]/,
  /useRequireFeature\(\s*['"]whatsapp['"]/,
  /isFeatureEnabled\([^)]*['"]whatsapp['"]/,
  /isEnabled\(\s*['"]whatsapp['"]/,
  /featureKey:\s*['"]whatsapp['"]/,
  /enabledFeatures[^\n]*whatsapp/,
  /features\??\.whatsapp\b/,
];

describe('wa.me surfaces are independent of the `whatsapp` feature flag', () => {
  it.each(WA_ME_SURFACES)('%s never reads the whatsapp feature', rel => {
    const abs = join(ROOT, rel);
    // A moved/renamed surface must update this list rather than silently drop out.
    expect(existsSync(abs), `${rel} missing — update WA_ME_SURFACES`).toBe(true);
    const src = readFileSync(abs, 'utf8');
    for (const re of FEATURE_FLAG_READ) {
      expect(re.test(src), `${rel} matches ${re}`).toBe(false);
    }
  });
});
