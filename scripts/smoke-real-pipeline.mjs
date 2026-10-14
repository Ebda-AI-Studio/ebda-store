#!/usr/bin/env node
// Full-pipeline smoke test. Imports the compiled EmailService from
// apps/api/dist and calls sendOrderConfirmation with sample data —
// exercises renderBrandedShell (logo + HSL theme sanitisation + RTL) +
// ResendService.sendBrandedEmail end-to-end against the real store row
// in prod Neon. No real order is created.
//
// Run with:
//   RESEND_API_KEY=re_xxx node scripts/smoke-real-pipeline.mjs

import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, '../apps/api/.env') });

const RECIPIENT = process.env.SMOKE_RECIPIENT || 'ahmed0montaser@gmail.com';
const STORE_SLUG = process.env.SMOKE_STORE_SLUG || 'demo-shop';

if (!process.env.RESEND_API_KEY && !process.env.SMTP_PASSWORD) {
  console.error('✗ neither RESEND_API_KEY nor SMTP_PASSWORD is set.');
  process.exit(1);
}

const { createPrismaClient } = await import('@ebda/database');
const prisma = createPrismaClient({ connectionString: process.env.DATABASE_URL ?? '', role: 'owner' });

const store = await prisma.store.findFirst({
  where: { slug: STORE_SLUG },
  select: { id: true, name: true, logo: true, theme: true, domain: true },
});
if (!store) {
  console.error(`✗ store '${STORE_SLUG}' not found`);
  process.exit(1);
}

console.log('✓ store:', store.id, '|', store.name);
console.log('✓ logo:', store.logo ? '(set)' : '(none)');
console.log('✓ theme.primaryColor:', store.theme?.primaryColor || '(none)');

const { EmailService } = await import(
  resolve(__dirname, '../apps/api/dist/services/email.service.js')
);

const sampleOrder = {
  orderNumber: `SMOKE-${Date.now().toString().slice(-6)}`,
  customerEmail: RECIPIENT,
  customerName: 'Ahmad Sharaf',
  items: [
    {
      name: 'Smoke test item (this is not a real order)',
      quantity: 1,
      price: 1000, // 1.000 KWD
    },
  ],
  subtotal: 1000,
  shipping: 0,
  tax: 0,
  total: 1000,
  shippingAddress: {
    firstName: 'Ahmad',
    lastName: 'Sharaf',
    address1: 'Smoke test address — no order was created',
    city: 'Kuwait City',
    state: '',
    postalCode: '',
    country: 'Kuwait',
  },
};

console.log('→ calling EmailService.sendOrderConfirmation(storeId, data)...');
try {
  await EmailService.sendOrderConfirmation(store.id, sampleOrder);
  console.log('✓ pipeline returned cleanly');
  console.log(`\n→ Check inbox at ${RECIPIENT}.`);
  console.log("  Header should show Demo Shop's logo over a wine-red bar (HSL 348 68% 25%).");
  console.log('  Body should render RTL because defaultLanguage = ar.');
} catch (err) {
  console.error('✗ pipeline failed:', err);
  process.exit(1);
} finally {
  await prisma.$disconnect();
}
