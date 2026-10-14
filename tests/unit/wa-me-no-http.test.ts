/**
 * SP8 scope guard: the FREE tier is `wa.me` click-to-chat ONLY. Building the
 * link, rendering the COD "Confirm on WhatsApp" flow and composing the order
 * email must make ZERO outbound HTTP calls, and the free-tier sources must not
 * import any WhatsApp API / bridge / unofficial-library code.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('@web/contexts/StoreContext', () => ({
  useStore: () => ({
    store: { name: 'S', slug: 's', whatsapp: '01012345678', theme: {} },
  }),
}));
vi.mock('@web/contexts/LanguageContext', () => ({
  useLanguage: () => ({ language: 'ar', isRtl: true, t: (en: string, ar?: string) => ar ?? en }),
}));

import { buildCodConfirmationMessage, waMeLink } from '@ebda/shared';
import { orderConfirmationTemplate } from '@api/services/email-templates/order-confirmation';
import { buildOrderEmailWaMe } from '@api/services/email-templates/_wa-me';

const root = path.resolve(__dirname, '../..');

afterEach(() => vi.restoreAllMocks());

describe('free tier makes no outbound HTTP call', () => {
  it('COD confirm flow (link + storefront button + email) never touches the network', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network used'));
    const httpSpy = vi.spyOn(http, 'request');
    const httpsSpy = vi.spyOn(https, 'request');

    const { WaMeCodConfirmButton } = await import('@web/templates/shared/WaMeButtons');
    const order = {
      orderNumber: 'EB-1',
      total: 10000,
      items: [{ quantity: 1, product: { name: 'P' } }],
    };
    const markup = renderToStaticMarkup(React.createElement(WaMeCodConfirmButton, { order }));
    expect(markup).toContain('https://wa.me/201012345678');

    const msg = buildCodConfirmationMessage({
      locale: 'en',
      orderNumber: 'EB-1',
      items: [{ name: 'P', quantity: 1 }],
      totalMinor: 10000,
    });
    expect(waMeLink('01012345678', msg)).toContain('wa.me');

    const d = {
      orderNumber: 'EB-1',
      customerName: 'M',
      customerEmail: 'm@x.com',
      items: [{ name: 'P', quantity: 1, price: 10000 }],
      subtotal: 10000,
      tax: 0,
      shipping: 0,
      total: 10000,
      isCod: true,
      shippingAddress: {
        firstName: 'M',
        lastName: 'A',
        address1: 'a',
        city: 'c',
        state: 's',
        postalCode: '',
        country: 'EG',
      },
    };
    const waMe = buildOrderEmailWaMe(d, { name: 'S', whatsapp: '01012345678' }, 'en');
    expect(orderConfirmationTemplate.en({ ...d, waMe }, 'S')).toContain('wa.me');

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(httpSpy).not.toHaveBeenCalled();
    expect(httpsSpy).not.toHaveBeenCalled();
  });

  it('free-tier sources import no WhatsApp API / bridge / network code', () => {
    const files = [
      'packages/shared/src/whatsapp/wa-me.ts',
      'packages/shared/src/whatsapp/wa-me-messages.ts',
      'apps/web/src/templates/shared/WaMeButtons.tsx',
      'apps/api/src/services/email-templates/_wa-me.ts',
      'apps/admin/src/app/stores/[id]/orders/[orderId]/_components/useMessageCustomer.ts',
    ];
    for (const f of files) {
      // Comments may legitimately say "no Cloud API" — only code is checked.
      const src = fs
        .readFileSync(path.join(root, f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      expect(src, f).not.toMatch(
        /\bfetch\s*\(|axios|XMLHttpRequest|node:https?|from ['"]https?['"]/
      );
      expect(src, f).not.toMatch(
        /wbs-bridge|wbsBridge|whatsapp-web|baileys|venom-bot|Cloud API|graph\.facebook|whatsappAutomation/i
      );
    }
  });
});
