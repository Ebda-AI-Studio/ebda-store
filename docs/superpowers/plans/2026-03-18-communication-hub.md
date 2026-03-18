# Communication Hub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a unified notification system that sends order-lifecycle messages via WhatsApp (Meta Cloud API), SMS (Unifonic), and Push Notifications (Firebase) with per-store credentials and per-event channel toggles.

**Architecture:** Notification Dispatcher orchestrates events to channel-specific services (WhatsApp, SMS, Push), each with its own Redis queue, circuit breaker, and provider client. Per-store credentials stored encrypted. Integrates with existing order lifecycle and Feature Toggle Engine.

**Tech Stack:** Meta WhatsApp Cloud API (raw fetch), Unifonic REST API (raw fetch), Firebase Admin SDK, Redis queues, AES-256-GCM encryption, Express.js, Prisma, React/Next.js

**Spec:** `docs/superpowers/specs/2026-03-18-communication-hub-design.md`

---

## File Structure

**New files:**
| File | Responsibility |
|------|---------------|
| `packages/shared/src/notifications.ts` | Event types, channel types, template definitions, Zod schemas |
| `apps/api/src/services/notification-config.service.ts` | Credential CRUD + encryption for per-store channel configs |
| `apps/api/src/services/whatsapp.service.ts` | Meta Cloud API calls (send template message) |
| `apps/api/src/services/whatsapp-queue.service.ts` | Redis queue for WhatsApp (LPUSH/RPOP, retry, circuit breaker) |
| `apps/api/src/services/sms.service.ts` | Unifonic REST API calls |
| `apps/api/src/services/sms-queue.service.ts` | Redis queue for SMS |
| `apps/api/src/services/push.service.ts` | Firebase Admin SDK (subscribe, unsubscribe, send) |
| `apps/api/src/services/notification-dispatcher.service.ts` | Orchestrator — routes events to enabled channels |
| `apps/api/src/routes/notification.routes.ts` | Admin endpoints for config, events, logs, test |
| `apps/admin/src/app/stores/[id]/notifications/page.tsx` | Notification settings UI |
| `apps/web/src/components/PushNotificationPrompt.tsx` | Push permission + subscription prompt |
| `tests/unit/notification.test.ts` | Unit tests |

**Modified files:**
| File | Change |
|------|--------|
| `packages/database/prisma/schema.prisma` | Add 4 models: NotificationConfig, NotificationEventConfig, PushSubscription, NotificationLog |
| `apps/api/src/routes/index.ts` | Mount notification routes |
| `apps/api/src/services/order.service.ts` | Add dispatcher calls after emails |
| `apps/api/src/routes/webhook.routes.ts` | Add WhatsApp webhook endpoints |
| `apps/api/src/services/circuit-breaker.service.ts` | Register whatsapp + sms circuits |
| `apps/admin/src/app/stores/[id]/settings/page.tsx` | Add Notifications settings card |
| `apps/web/src/app/layout.tsx` | Add PushNotificationPrompt |

---

## Task 1: Shared Notification Types

**Files:**

- Create: `packages/shared/src/notifications.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Create notification types and templates**

Create `packages/shared/src/notifications.ts` with:

- `NotificationChannel` type: `'whatsapp' | 'sms' | 'push'`
- `NotificationEvent` type: `'order_confirmed' | 'payment_success' | 'order_shipped' | 'order_delivered' | 'order_cancelled' | 'refund_processed'`
- `NOTIFICATION_EVENTS` const array
- `NOTIFICATION_CHANNELS` const array
- `NotificationData` interface: `{ customerName, customerPhone?, orderNumber, total?, trackingNumber?, reason?, amount?, storeId, storeName }`
- `WhatsAppTemplate` interface: `{ name: string, language: string, variables: string[] }`
- `WHATSAPP_TEMPLATES` map: event → template config
- `SMS_TEMPLATES` map: event → `{ en: string, ar: string }` with `{name}`, `{number}`, `{total}`, `{tracking}` placeholders
- `PUSH_TEMPLATES` map: event → `{ title: { en, ar }, body: { en, ar } }`
- Zod schemas: `notificationChannelSchema`, `notificationEventSchema`, `notificationEventConfigSchema`

- [ ] **Step 2: Export from barrel**

Add `export * from './notifications'` to `packages/shared/src/index.ts`.

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(shared): add notification types, templates, and zod schemas"
```

---

## Task 2: Prisma Schema — Notification Models

**Files:**

- Modify: `packages/database/prisma/schema.prisma`

- [ ] **Step 1: Add 4 new models**

Add after the StoreFeature model:

1. `NotificationConfig` — per-store channel credentials (encrypted JSON). Fields: id, storeId, channel, provider, credentials (Json), enabled, createdAt, updatedAt. `@@unique([storeId, channel])`
2. `NotificationEventConfig` — per-store per-event channel toggles. Fields: id, storeId, event, whatsapp, sms, push (all Boolean @default(true)). `@@unique([storeId, event])`
3. `PushSubscription` — browser push subscriptions. Fields: id, storeId, customerId?, endpoint, p256dh, auth, deviceInfo?, createdAt. `@@unique([storeId, endpoint])`
4. `NotificationLog` — audit trail. Fields: id, storeId, channel, event, recipientPhoneHash?, recipientEmailHash?, status, providerMessageId?, idempotencyKey? (@@unique), error?, metadata (Json), createdAt, updatedAt.

Add relation fields on Store model: `notificationConfigs NotificationConfig[]`, `notificationEventConfigs NotificationEventConfig[]`, `pushSubscriptions PushSubscription[]`, `notificationLogs NotificationLog[]`

Add relation on User model: `pushSubscriptions PushSubscription[] @relation("UserPushSubscriptions")`

Use `@@map()` for all tables matching existing snake_case convention.

- [ ] **Step 2: Run prisma generate**

```bash
cd /Users/ahmadsharaf/Desktop/projects/force-website-builder && npm run db:generate
```

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(database): add notification config, event config, push subscription, and log models"
```

---

## Task 3: Notification Config Service (Credential Management)

**Files:**

- Create: `apps/api/src/services/notification-config.service.ts`

- [ ] **Step 1: Create the service**

This service manages per-store channel credentials with encryption. Pattern to follow:

- Import `{ prisma } from '@force/database'`
- Import `{ encryption } from './encryption.service'`
- Import `{ redis } from './redis.service'`

Methods:

- `getStoreConfigs(storeId)` — Returns all channel configs, decrypts credentials. Redis cached at `notification:config:{storeId}` (5min TTL).
- `getConfig(storeId, channel)` — Single channel config, decrypted.
- `upsertConfig(storeId, channel, data)` — Encrypts credentials before storing. Invalidates cache.
- `deleteConfig(storeId, channel)` — Remove config. Invalidates cache.
- `testConnection(storeId, channel)` — Calls the appropriate provider's test method.

Credentials are encrypted with `encryption.encrypt(JSON.stringify(credentials))` before DB write and decrypted with `JSON.parse(encryption.decrypt(row.credentials))` on read.

Export as `notificationConfigService` singleton.

- [ ] **Step 2: Commit**

```bash
git commit -m "feat(api): add notification config service with encrypted credential storage"
```

---

## Task 4: WhatsApp Service + Queue

**Files:**

- Create: `apps/api/src/services/whatsapp.service.ts`
- Create: `apps/api/src/services/whatsapp-queue.service.ts`

- [ ] **Step 1: Create WhatsApp service**

Meta Cloud API client. Uses raw `fetch()` (no SDK):

```typescript
const META_API_BASE = 'https://graph.facebook.com/v21.0';

class WhatsAppService {
  async sendTemplateMessage(
    config: { phoneNumberId: string; accessToken: string },
    to: string,
    templateName: string,
    languageCode: string,
    variables: string[]
  ): Promise<{ messageId: string }> {
    const response = await fetch(`${META_API_BASE}/${config.phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: {
          name: templateName,
          language: { code: languageCode },
          components: [
            {
              type: 'body',
              parameters: variables.map(v => ({ type: 'text', text: v })),
            },
          ],
        },
      }),
    });
    // Parse response, return messageId, throw on error
  }
}
```

Also add: `verifyWebhook(mode, token, challenge, verifyToken)` and `processWebhookEvent(body)`.

- [ ] **Step 2: Create WhatsApp queue**

Replicate the exact pattern from `email-queue.service.ts`:

- Redis key: `whatsapp:queue`
- Failed key: `whatsapp:failed`
- LPUSH to enqueue, RPOP to dequeue
- 3 retry attempts with exponential backoff
- Circuit breaker: `withCircuitBreaker('whatsapp', ...)`
- Generate idempotencyKey: `${storeId}:${event}:${orderId}:whatsapp:${Date.now()}`
- Before sending, check NotificationLog for duplicate idempotencyKey
- After sending, create NotificationLog entry with recipientPhoneHash (SHA-256)
- `startProcessing(intervalMs)` polls queue every 2000ms

Read `apps/api/src/services/email-queue.service.ts` and replicate the EXACT pattern, changing only the queue keys, service calls, and adding idempotency.

- [ ] **Step 3: Register circuit breaker**

In `apps/api/src/services/circuit-breaker.service.ts`, add after the email registration (line ~198):

```typescript
circuitBreaker.register('whatsapp', { failureThreshold: 5, timeout: 30000 });
circuitBreaker.register('sms', { failureThreshold: 5, timeout: 30000 });
```

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(api): add whatsapp service and redis queue with meta cloud api"
```

---

## Task 5: SMS Service + Queue

**Files:**

- Create: `apps/api/src/services/sms.service.ts`
- Create: `apps/api/src/services/sms-queue.service.ts`

- [ ] **Step 1: Create SMS service**

Unifonic REST API client:

```typescript
const UNIFONIC_API = 'https://el.cloud.unifonic.com/rest/SMS/messages';

class SmsService {
  async sendSms(
    config: { appSid: string; senderId: string },
    to: string,
    message: string
  ): Promise<{ messageId: string }> {
    const response = await fetch(UNIFONIC_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        AppSid: config.appSid,
        SenderID: config.senderId,
        Recipient: to,
        Body: message,
      }),
    });
    // Parse, return messageId, throw on error
  }
}
```

- [ ] **Step 2: Create SMS queue**

Same pattern as WhatsApp queue but with `sms:queue` / `sms:failed` keys. Uses `withCircuitBreaker('sms', ...)`.

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(api): add sms service and redis queue with unifonic api"
```

---

## Task 6: Push Notification Service

**Files:**

- Create: `apps/api/src/services/push.service.ts`

- [ ] **Step 1: Install firebase-admin**

```bash
cd /Users/ahmadsharaf/Desktop/projects/force-website-builder
npm install firebase-admin -w apps/api
```

- [ ] **Step 2: Create Push service**

```typescript
import * as admin from 'firebase-admin';

class PushService {
  private apps: Map<string, admin.app.App> = new Map(); // Per-store Firebase apps

  getApp(storeId: string, serviceAccount: object): admin.app.App {
    if (!this.apps.has(storeId)) {
      this.apps.set(
        storeId,
        admin.initializeApp(
          {
            credential: admin.credential.cert(serviceAccount as admin.ServiceAccount),
          },
          `store-${storeId}`
        )
      );
    }
    return this.apps.get(storeId)!;
  }

  async sendToStore(
    storeId: string,
    title: string,
    body: string,
    data?: Record<string, string>
  ): Promise<void> {
    // 1. Get store's Firebase config from notificationConfigService
    // 2. Get all PushSubscription endpoints for this store
    // 3. Send via FCM multicast
    // 4. Clean up expired subscriptions (410 Gone responses)
    // 5. Log to NotificationLog
  }

  async subscribe(
    storeId: string,
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
    customerId?: string
  ): Promise<void> {
    // Upsert PushSubscription (@@unique on storeId + endpoint prevents duplicates)
  }

  async unsubscribe(endpoint: string): Promise<void> {
    // Delete PushSubscription by endpoint
  }
}
```

No queue needed — FCM handles batching internally.

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(api): add push notification service with firebase admin"
```

---

## Task 7: Notification Dispatcher (Orchestrator)

**Files:**

- Create: `apps/api/src/services/notification-dispatcher.service.ts`

- [ ] **Step 1: Create the dispatcher**

This is the core orchestrator. It:

1. Checks feature flags for each channel
2. Gets event config (which channels for this event)
3. Gets channel credentials
4. Dispatches to enabled + configured channels
5. Logs skipped channels explicitly

```typescript
import { featureService } from './feature.service';
import { notificationConfigService } from './notification-config.service';
import { whatsappQueue } from './whatsapp-queue.service';
import { smsQueue } from './sms-queue.service';
import { pushService } from './push.service';
import { NotificationEvent, NotificationData, WHATSAPP_TEMPLATES, SMS_TEMPLATES, PUSH_TEMPLATES } from '@force/shared';

class NotificationDispatcher {
  async dispatch(storeId: string, event: NotificationEvent, data: NotificationData): Promise<void> {
    // 1. Check feature flags in parallel
    const [whatsappEnabled, smsEnabled, pushEnabled] = await Promise.all([
      featureService.isFeatureEnabled(storeId, 'whatsapp'),
      featureService.isFeatureEnabled(storeId, 'sms'),
      featureService.isFeatureEnabled(storeId, 'push_notifications'),
    ]);

    // 2. Get event config
    const eventConfig = await this.getEventConfig(storeId, event);

    // 3. Get channel credentials
    const configs = await notificationConfigService.getStoreConfigs(storeId);

    // 4. Dispatch to each channel (fire-and-forget, never blocks caller)
    const dispatches: Promise<void>[] = [];

    if (whatsappEnabled && eventConfig.whatsapp && configs.whatsapp?.enabled && data.customerPhone) {
      dispatches.push(this.dispatchWhatsApp(storeId, event, data, configs.whatsapp));
    }
    if (smsEnabled && eventConfig.sms && configs.sms?.enabled && data.customerPhone) {
      dispatches.push(this.dispatchSms(storeId, event, data, configs.sms));
    }
    if (pushEnabled && eventConfig.push && configs.push?.enabled) {
      dispatches.push(this.dispatchPush(storeId, event, data));
    }

    // Fire all, catch errors (never fail the caller)
    await Promise.allSettled(dispatches);
  }

  private async getEventConfig(storeId: string, event: string) {
    // Query NotificationEventConfig, default all true if no row
  }

  private async dispatchWhatsApp(...) { /* build template, enqueue */ }
  private async dispatchSms(...) { /* build message from template, enqueue */ }
  private async dispatchPush(...) { /* build payload, send via pushService */ }
}
```

**CRITICAL:** Read `apps/api/src/services/order.service.ts` to see how `EmailService` is called. The dispatcher must follow the same fire-and-forget pattern — errors logged, never thrown.

- [ ] **Step 2: Commit**

```bash
git commit -m "feat(api): add notification dispatcher to orchestrate multi-channel delivery"
```

---

## Task 8: Notification API Routes

**Files:**

- Create: `apps/api/src/routes/notification.routes.ts`
- Modify: `apps/api/src/routes/index.ts`

- [ ] **Step 1: Create notification routes**

Follow the pattern from `apps/api/src/routes/coupon.routes.ts` (import style, middleware chain).

Admin routes (authenticate + authorize('store_admin', 'super_admin') + requireStoreAccess):

- `GET /:storeId/notifications/configs` — list all channel configs
- `GET /:storeId/notifications/configs/:channel` — get channel config (credentials masked)
- `PUT /:storeId/notifications/configs/:channel` — upsert credentials
- `DELETE /:storeId/notifications/configs/:channel` — remove config
- `POST /:storeId/notifications/test/:channel` — test connection
- `GET /:storeId/notifications/events` — get event configs
- `PUT /:storeId/notifications/events` — update event configs
- `GET /:storeId/notifications/logs` — paginated notification logs
- `GET /:storeId/notifications/stats` — notification statistics

Public routes:

- `POST /public/:storeId/push/subscribe` — register push subscription
- `POST /public/:storeId/push/unsubscribe` — remove subscription

**Credential masking:** When returning configs to the admin, mask sensitive fields (show last 4 chars of access tokens, full sender IDs).

- [ ] **Step 2: Mount in index.ts**

```typescript
import notificationRoutes from './notification.routes';
router.use('/stores', notificationRoutes);
```

Also mount the public push routes under `/public`.

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(api): add notification management and push subscription endpoints"
```

---

## Task 9: WhatsApp Webhook

**Files:**

- Modify: `apps/api/src/routes/webhook.routes.ts`

- [ ] **Step 1: Add WhatsApp webhook endpoints**

Read the existing webhook.routes.ts pattern. Add:

```typescript
// WhatsApp webhook verification
router.get('/whatsapp', (req, res) => {
  // Meta sends: hub.mode, hub.verify_token, hub.challenge
  // Verify against stored webhook verify token
  // Return challenge on success
});

// WhatsApp delivery status updates
router.post('/whatsapp', express.json(), async (req, res) => {
  // 1. Verify X-Hub-Signature-256 header (HMAC-SHA256 of raw body)
  // 2. Parse status updates from webhook payload
  // 3. Update NotificationLog status
  // 4. Handle out-of-order: only update if new status > current status
  // Status hierarchy: queued(0) < sent(1) < delivered(2) < read(3)
});
```

**IMPORTANT:** The WhatsApp webhook needs the raw body for signature verification. Check how payment webhooks handle this (they use `express.raw()`). You may need to mount the WhatsApp webhook before body parsing middleware.

- [ ] **Step 2: Commit**

```bash
git commit -m "feat(api): add whatsapp webhook for delivery status tracking"
```

---

## Task 10: Integrate Dispatcher with Order Lifecycle

**Files:**

- Modify: `apps/api/src/services/order.service.ts`

- [ ] **Step 1: Add dispatcher to order creation**

Read order.service.ts. After the email Promise.all (around line 302), add:

```typescript
import { notificationDispatcher } from './notification-dispatcher.service';

// After emails, dispatch to other channels (fire-and-forget)
notificationDispatcher
  .dispatch(storeId, 'order_confirmed', {
    customerName: `${customer.firstName} ${customer.lastName}`.trim(),
    customerPhone: customer.phone || shippingAddress?.phone,
    orderNumber: order.orderNumber,
    total: order.total,
    storeId,
    storeName: store.name,
  })
  .catch(err => logger.error('Notification dispatch failed:', err));
```

- [ ] **Step 2: Add dispatcher to status updates**

In the updateStatus method (around lines 417-467), add dispatcher calls for each status:

- `'confirmed'` → `'order_confirmed'` (if not already sent from create)
- `'shipped'` → `'order_shipped'` (include tracking number)
- `'delivered'` → `'order_delivered'`
- `'cancelled'` → `'order_cancelled'`
- `'refunded'` → `'refund_processed'`

Each call wrapped in `.catch()` to never fail the status update.

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(order): integrate notification dispatcher with order lifecycle"
```

---

## Task 11: Admin UI — Notifications Page

**Files:**

- Create: `apps/admin/src/app/stores/[id]/notifications/page.tsx`
- Modify: `apps/admin/src/app/stores/[id]/settings/page.tsx`

- [ ] **Step 1: Read existing admin patterns**

Read these files to match patterns:

- `apps/admin/src/app/stores/[id]/settings/page.tsx` — settings card layout
- `apps/admin/src/app/stores/[id]/loyalty/page.tsx` — form pattern with sections
- `apps/admin/src/hooks/useFeatures.tsx` — feature gating

- [ ] **Step 2: Create notifications page**

A `'use client'` component with sections for each channel. Gated by feature flags using `useFeatures()`:

**Sections:**

1. WhatsApp Setup (if `isEnabled('whatsapp')`) — credential form, test button, stats
2. SMS Setup (if `isEnabled('sms')`) — credential form, test button
3. Push Setup (if `isEnabled('push_notifications')`) — Firebase JSON upload, subscriber count
4. Event Configuration — grid of checkboxes (event × channel), only shows enabled channels
5. Recent Notifications — paginated log table

Match the exact Tailwind patterns, `apiGet`/`apiPut` usage, and toast notifications from existing pages.

- [ ] **Step 3: Add Notifications card to settings**

In settings/page.tsx, add a card:

```typescript
{
  title: 'Notifications',
  description: 'WhatsApp, SMS, and Push notification settings',
  href: `/stores/${storeId}/notifications`,
  icon: /* bell SVG */,
  color: 'bg-teal-100 text-teal-600',
}
```

This card should always show (the page itself gates per-channel sections).

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(admin): add notifications settings page with channel configuration"
```

---

## Task 12: Web Storefront — Push Notification Prompt

**Files:**

- Create: `apps/web/src/components/PushNotificationPrompt.tsx`
- Modify: `apps/web/src/app/layout.tsx`

- [ ] **Step 1: Create push notification prompt component**

```tsx
'use client';

import { useEffect, useState } from 'react';
import { useFeatures } from '../contexts/FeatureContext';
import { useStore } from '../contexts/StoreContext';

export function PushNotificationPrompt() {
  const { isEnabled } = useFeatures();
  const { store } = useStore();

  if (!isEnabled('push_notifications')) return null;

  // Check if already dismissed (localStorage)
  // Check if browser supports push
  // Check if already subscribed
  // Show permission prompt UI
  // On accept: register service worker, get subscription, POST to /public/:storeId/push/subscribe
  // On decline: save to localStorage, never show again
}
```

Read `apps/web/src/components/ServiceWorkerRegistration.tsx` for the existing SW pattern.

- [ ] **Step 2: Add to layout.tsx**

After `ServiceWorkerRegistration`, add:

```tsx
<PushNotificationPrompt />
```

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(web): add push notification permission prompt and subscription"
```

---

## Task 13: Start Queue Processing on Server Boot

**Files:**

- Modify: `apps/api/src/index.ts`

- [ ] **Step 1: Start WhatsApp and SMS queue processing**

Read `apps/api/src/index.ts` to find where `emailQueue.startProcessing()` is called (around line 38). Add:

```typescript
import { whatsappQueue } from './services/whatsapp-queue.service';
import { smsQueue } from './services/sms-queue.service';

// After emailQueue.startProcessing()
whatsappQueue.startProcessing(2000);
smsQueue.startProcessing(2000);
```

- [ ] **Step 2: Commit**

```bash
git commit -m "feat(api): start whatsapp and sms queue processing on server boot"
```

---

## Task 14: Unit Tests

**Files:**

- Create: `tests/unit/notification.test.ts`

- [ ] **Step 1: Write tests**

Test:

1. Notification types — event array has 6 entries, channel array has 3
2. SMS template rendering — variables replaced correctly, bilingual
3. WhatsApp template building — correct Meta API payload structure
4. Notification dispatcher — mocked: dispatches to enabled channels only, skips disabled, logs skipped reasons
5. Notification config — encryption/decryption round-trip
6. Idempotency — duplicate dispatch with same key is skipped

Follow pattern from `tests/unit/feature.test.ts`.

- [ ] **Step 2: Run tests**

```bash
npx vitest run tests/unit/notification.test.ts
```

- [ ] **Step 3: Commit**

```bash
git commit -m "test(api): add unit tests for notification services and dispatcher"
```

---

## Task 15: Final Verification

- [ ] **Step 1: Run full test suite**

```bash
npm run test
```

- [ ] **Step 2: Build all workspaces**

```bash
npm run build
```

- [ ] **Step 3: Commit**

```bash
git commit -m "feat: complete phase 1 communication hub implementation"
```
