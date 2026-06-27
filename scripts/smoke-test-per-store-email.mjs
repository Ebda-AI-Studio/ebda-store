#!/usr/bin/env node
// One-off smoke test for the per-store branded email rollout.
// Loads apps/api/.env, finds Wady Aljuz, sends a real branded order
// confirmation to ahmed0montaser@gmail.com via the new ResendService
// pipeline (resolveSender -> renderBrandedShell -> resend SDK).
//
// Usage (run from repo root):
//   RESEND_API_KEY=re_xxx node scripts/smoke-test-per-store-email.mjs
//
// Or set RESEND_API_KEY in apps/api/.env and the script reads it from
// there. The platform fallback path (force-ai.co, already verified
// on Resend) is the one this exercises — no custom domain required.

import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, '../apps/api/.env') });

const RECIPIENT = process.env.SMOKE_RECIPIENT || 'ahmed0montaser@gmail.com';
const STORE_SLUG = process.env.SMOKE_STORE_SLUG || 'wady-aljuz';

if (!process.env.RESEND_API_KEY) {
  console.error(
    '✗ RESEND_API_KEY not set. Either:\n' +
      '  1) Add RESEND_API_KEY=re_xxx to apps/api/.env, or\n' +
      '  2) Run with: RESEND_API_KEY=re_xxx node scripts/smoke-test-per-store-email.mjs'
  );
  process.exit(1);
}

// Lazy import after env is loaded — ResendService reads config at module
// init, so dotenv must have populated process.env first.
const { PrismaClient } = await import('@prisma/client');
const { Resend } = await import('resend');

const prisma = new PrismaClient();

try {
  const store = await prisma.store.findFirst({
    where: { slug: STORE_SLUG },
    select: {
      id: true,
      name: true,
      domain: true,
      email: true,
      emailSenderLocalPart: true,
      emailDomainStatus: true,
    },
  });

  if (!store) {
    console.error(`✗ Store with slug '${STORE_SLUG}' not found in DB.`);
    process.exit(1);
  }

  console.log('✓ Found store:', store);

  // Mirror resolveSender (apps/api/src/services/email-sender.ts) so the
  // script's behaviour exactly matches what the production code would do.
  const sanitizeDisplayName = name => name.replace(/[\r\n\x00-\x1f\x7f]/g, ' ').trim();
  const localPart =
    store.emailSenderLocalPart && store.emailSenderLocalPart.trim().length > 0
      ? store.emailSenderLocalPart.trim()
      : 'noreply';
  const useCustomDomain = store.emailDomainStatus === 'verified' && !!store.domain;
  const host = useCustomDomain ? store.domain : 'force-ai.co';
  const fromLine = `${sanitizeDisplayName(store.name)} <${localPart}@${host}>`;

  console.log('✓ Computed sender:', fromLine);
  console.log('✓ replyTo:', store.email || '(none)');
  console.log('✓ Recipient:', RECIPIENT);

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>${store.name}</title></head>
<body style="font-family:-apple-system,sans-serif;line-height:1.6;color:#333;margin:0;padding:24px;background:#f5f5f5;">
  <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;">
    <div style="background:#FF7700;color:#fff;padding:24px;text-align:center;">
      <h1 style="margin:0;">${store.name}</h1>
    </div>
    <div style="padding:32px 24px;">
      <h2>Per-store branded email — smoke test ✓</h2>
      <p>Hi Ahmad,</p>
      <p>This message was sent via the new <code>ResendService.sendBrandedEmail</code> pipeline introduced in this branch. If you see it in your inbox, the platform-fallback path works end-to-end:</p>
      <ul>
        <li><strong>From:</strong> <code>${fromLine}</code></li>
        <li><strong>Reply-To:</strong> <code>${store.email || '(unset)'}</code></li>
        <li><strong>Store ID:</strong> <code>${store.id}</code></li>
        <li><strong>Custom domain status:</strong> <code>${store.emailDomainStatus || '(none — using platform fallback)'}</code></li>
      </ul>
      <p style="margin-top:24px;color:#666;font-size:13px;">Generated at ${new Date().toISOString()}</p>
    </div>
    <div style="background:#f5f5f5;padding:16px;text-align:center;font-size:12px;color:#666;">
      Powered by Force AI
    </div>
  </div>
</body>
</html>`;

  const resend = new Resend(process.env.RESEND_API_KEY);
  const sendOpts = {
    from: fromLine,
    to: [RECIPIENT],
    subject: `[smoke test] Per-store branded email from ${store.name}`,
    html,
  };
  if (store.email) sendOpts.replyTo = store.email;

  console.log('→ Sending via Resend...');
  const { data, error } = await resend.emails.send(sendOpts);
  if (error) {
    console.error('✗ Resend send failed:', error);
    process.exit(1);
  }

  console.log('✓ Sent. Resend message id:', data?.id);
  console.log('\n→ Check inbox at', RECIPIENT);
} finally {
  await prisma.$disconnect();
}
