# Phase 1: Communication Hub — Design Spec

## Overview

A unified notification system that sends order-lifecycle messages via WhatsApp (Meta Cloud API), SMS (Unifonic), and Push Notifications (Firebase Cloud Messaging). Each channel is independently toggleable per store via the Feature Toggle Engine. Per-store credentials. Follows the existing queue + circuit breaker + template patterns.

## Decisions

- **WhatsApp provider:** Meta WhatsApp Cloud API (direct, not via Twilio)
- **SMS provider:** Unifonic (Kuwait/GCC focused, better local rates)
- **Push provider:** Firebase Cloud Messaging (free, PWA-compatible)
- **Multi-tenant:** Per-store credentials for all channels (each store brings their own API keys)
- **Channel independence:** Each channel (whatsapp, sms, push) is independently toggleable per store. A store can enable any combination.
- **Event granularity:** Per-store, per-event, per-channel toggles (e.g., store A sends order_shipped via WhatsApp only, store B sends it via SMS + Push)
- **Scope:** Order lifecycle events only (confirmed, payment success, shipped, delivered, cancelled, refunded). Abandoned cart, campaigns, and account events are in later phases.

## Architecture

### Notification Flow

```
OrderService.updateStatus('shipped')
  → notificationDispatcher.dispatch(storeId, 'order_shipped', data)
    → check feature flags: whatsapp enabled? sms enabled? push enabled?
    → check event config: which channels for 'order_shipped'?
    → check credentials: channel configured?
    → for each enabled + configured channel:
      → whatsapp → whatsappQueue.enqueue(message)
      → sms → smsQueue.enqueue(message)
      → push → pushService.sendToStore(storeId, notification)
    → log to NotificationLog
    → email continues via existing EmailService (no change)
```

### Service Architecture

```
apps/api/src/services/
  notification-dispatcher.service.ts  → Orchestrator: routes events to channels
  whatsapp.service.ts                 → Meta Cloud API calls
  whatsapp-queue.service.ts           → Redis queue for WhatsApp messages
  sms.service.ts                      → Unifonic API calls
  sms-queue.service.ts                → Redis queue for SMS messages
  push.service.ts                     → Firebase Admin SDK
  notification-config.service.ts      → CRUD for per-store channel credentials
```

## Data Layer

### New Prisma Models

```prisma
model NotificationConfig {
  id          String   @id @default(uuid())
  storeId     String   @map("store_id")
  channel     String   // 'whatsapp' | 'sms' | 'push'
  provider    String   // 'meta' | 'unifonic' | 'firebase'
  credentials Json     @default("{}") // Encrypted: apiToken, phoneNumberId, senderId, etc.
  enabled     Boolean  @default(false)
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")

  store Store @relation(fields: [storeId], references: [id], onDelete: Cascade)

  @@unique([storeId, channel])
  @@index([storeId])
  @@map("notification_configs")
}

model NotificationEventConfig {
  id         String  @id @default(uuid())
  storeId    String  @map("store_id")
  event      String  // 'order_confirmed' | 'payment_success' | 'order_shipped' | etc.
  whatsapp   Boolean @default(true)
  sms        Boolean @default(true)
  push       Boolean @default(true)

  store Store @relation(fields: [storeId], references: [id], onDelete: Cascade)

  @@unique([storeId, event])
  @@index([storeId])
  @@map("notification_event_configs")
}

model PushSubscription {
  id         String   @id @default(uuid())
  storeId    String   @map("store_id")
  customerId String?  @map("customer_id")
  endpoint   String
  p256dh     String
  auth       String
  deviceInfo String?  @map("device_info")
  createdAt  DateTime @default(now()) @map("created_at")

  store    Store @relation(fields: [storeId], references: [id], onDelete: Cascade)
  customer User? @relation("PushSubscriptions", fields: [customerId], references: [id], onDelete: SetNull)

  @@index([storeId])
  @@unique([storeId, endpoint]) // Prevent duplicate subscriptions
  @@index([customerId])
  @@map("push_subscriptions")
}

model NotificationLog {
  id                String   @id @default(uuid())
  storeId           String   @map("store_id")
  channel           String   // 'whatsapp' | 'sms' | 'push' | 'email'
  event             String   // 'order_confirmed' | etc.
  recipientPhoneHash String? @map("recipient_phone_hash") // SHA-256 hash of phone (no plaintext PII)
  recipientEmailHash String? @map("recipient_email_hash") // SHA-256 hash of email
  status            String   @default("queued") // 'queued' | 'sent' | 'delivered' | 'failed' | 'read'
  providerMessageId String?  @map("provider_message_id")
  idempotencyKey    String?  @map("idempotency_key") // Prevents duplicate sends on retry
  error             String?
  metadata          Json     @default("{}")
  createdAt         DateTime @default(now()) @map("created_at")
  updatedAt         DateTime @updatedAt @map("updated_at")

  store Store @relation(fields: [storeId], references: [id], onDelete: Cascade)

  @@unique([idempotencyKey])

  @@index([storeId])
  @@index([storeId, channel])
  @@index([storeId, event])
  @@index([status])
  @@map("notification_logs")
}
```

## WhatsApp (Meta Cloud API)

### Provider Details

- **API:** `https://graph.facebook.com/v21.0/{phoneNumberId}/messages`
- **Auth:** Bearer token (System User Access Token)
- **Message types:** Template messages (pre-approved by Meta)

### Per-Store Credentials (stored in NotificationConfig.credentials)

```json
{
  "phoneNumberId": "123456789",
  "wabaId": "987654321",
  "accessToken": "EAA...",
  "webhookVerifyToken": "random_verify_string"
}
```

### Template Messages

Each event maps to a Meta-approved template. Templates are defined in the code with variable placeholders:

| Event            | Template Name      | Variables                                               |
| ---------------- | ------------------ | ------------------------------------------------------- |
| order_confirmed  | `order_confirmed`  | {{1}} customer name, {{2}} order number, {{3}} total    |
| payment_success  | `payment_success`  | {{1}} customer name, {{2}} order number, {{3}} amount   |
| order_shipped    | `order_shipped`    | {{1}} customer name, {{2}} order number, {{3}} tracking |
| order_delivered  | `order_delivered`  | {{1}} customer name, {{2}} order number                 |
| order_cancelled  | `order_cancelled`  | {{1}} customer name, {{2}} order number, {{3}} reason   |
| refund_processed | `refund_processed` | {{1}} customer name, {{2}} order number, {{3}} amount   |

### WhatsApp Service

```typescript
class WhatsAppService {
  async sendTemplateMessage(
    config: WhatsAppConfig,
    to: string,
    templateName: string,
    variables: string[]
  ): Promise<string>;
  async verifyWebhook(
    mode: string,
    token: string,
    challenge: string,
    verifyToken: string
  ): string | null;
  async processWebhookEvent(body: any): void; // Update NotificationLog status
}
```

### WhatsApp Queue

- Redis key: `whatsapp:queue`
- Same LPUSH/RPOP pattern as email queue
- Circuit breaker: `circuitBreaker.register('whatsapp', { failureThreshold: 5, timeout: 30000 })`
- Retry: 3 attempts with exponential backoff

### WhatsApp Webhook

- `GET /webhooks/whatsapp` — Meta verification (returns challenge)
- `POST /webhooks/whatsapp` — Delivery status updates (sent, delivered, read, failed)
- Updates NotificationLog.status based on webhook events

## SMS (Unifonic)

### Provider Details

- **API:** `https://el.cloud.unifonic.com/rest/SMS/messages`
- **Auth:** App SID in request body
- **Message type:** Plain text SMS

### Per-Store Credentials (stored in NotificationConfig.credentials)

```json
{
  "appSid": "your_app_sid",
  "senderId": "StoreName"
}
```

### SMS Templates

Plain text messages, bilingual (language from store settings):

| Event           | EN Template                                                           | AR Template                                                   |
| --------------- | --------------------------------------------------------------------- | ------------------------------------------------------------- |
| order_confirmed | "Hi {name}, your order #{number} is confirmed! Total: {total} KWD"    | "مرحبا {name}، تم تأكيد طلبك #{number}! المجموع: {total} د.ك" |
| order_shipped   | "Hi {name}, your order #{number} has been shipped! Track: {tracking}" | "مرحبا {name}، تم شحن طلبك #{number}! التتبع: {tracking}"     |
| order_cancelled | "Hi {name}, your order #{number} has been cancelled."                 | "مرحبا {name}، تم إلغاء طلبك #{number}."                      |

### SMS Service

```typescript
class SmsService {
  async sendSms(config: SmsConfig, to: string, message: string): Promise<string>;
}
```

### SMS Queue

- Redis key: `sms:queue`
- Same pattern as WhatsApp queue
- Circuit breaker: `circuitBreaker.register('sms', { failureThreshold: 5, timeout: 30000 })`

## Push Notifications (Firebase Cloud Messaging)

### Provider Details

- **SDK:** `firebase-admin`
- **Auth:** Service Account JSON
- **Protocol:** Web Push (VAPID) via FCM

### Per-Store Credentials (stored in NotificationConfig.credentials)

```json
{
  "serviceAccount": {
    /* Firebase service account JSON */
  },
  "vapidPublicKey": "BL..."
}
```

### Push Service

```typescript
class PushService {
  async sendToStore(
    storeId: string,
    title: string,
    body: string,
    data?: Record<string, string>
  ): Promise<void>;
  async subscribe(
    storeId: string,
    subscription: PushSubscriptionData,
    customerId?: string
  ): Promise<void>;
  async unsubscribe(endpoint: string): Promise<void>;
}
```

No queue needed — FCM handles batching and retry internally.

### Service Worker Integration

- The web storefront's service worker registers for push notifications
- On notification permission grant, sends subscription to `POST /public/{storeId}/push/subscribe`
- Service worker handles incoming push events and shows native notifications

## Notification Dispatcher (Orchestrator)

```typescript
class NotificationDispatcher {
  async dispatch(storeId: string, event: NotificationEvent, data: NotificationData): Promise<void> {
    // 1. Check feature flags
    const [whatsappEnabled, smsEnabled, pushEnabled] = await Promise.all([
      featureService.isFeatureEnabled(storeId, 'whatsapp'),
      featureService.isFeatureEnabled(storeId, 'sms'),
      featureService.isFeatureEnabled(storeId, 'push_notifications'),
    ]);

    // 2. Get event config (which channels for this event)
    const eventConfig = await this.getEventConfig(storeId, event);

    // 3. Get channel credentials
    const configs = await notificationConfigService.getStoreConfigs(storeId);

    // 4. Dispatch to each enabled + configured channel
    if (whatsappEnabled && eventConfig.whatsapp && configs.whatsapp?.enabled) {
      await whatsappQueue.enqueue({ storeId, event, data, config: configs.whatsapp });
    }
    if (smsEnabled && eventConfig.sms && configs.sms?.enabled) {
      await smsQueue.enqueue({ storeId, event, data, config: configs.sms });
    }
    if (pushEnabled && eventConfig.push && configs.push?.enabled) {
      await pushService.sendToStore(storeId, ...buildPushPayload(event, data));
    }

    // 5. Log skipped channels explicitly (so admins know why messages aren't going out)
    const skipped = [];
    if (!whatsappEnabled) skipped.push('whatsapp:feature_disabled');
    if (whatsappEnabled && !eventConfig.whatsapp) skipped.push('whatsapp:event_disabled');
    if (whatsappEnabled && eventConfig.whatsapp && !configs.whatsapp?.enabled)
      skipped.push('whatsapp:not_configured');
    // Same for sms, push...

    await this.log(storeId, event, data, { whatsappEnabled, smsEnabled, pushEnabled, skipped });
  }
}
```

### Default Event Configuration

When a store first enables a channel, all events default to ON for that channel. The store admin can then disable specific events per channel.

## Notification Config Service

Manages per-store channel credentials with encryption:

```typescript
class NotificationConfigService {
  async getStoreConfigs(storeId: string): Promise<Record<string, NotificationConfig>>;
  async getConfig(storeId: string, channel: string): Promise<NotificationConfig | null>;
  async upsertConfig(
    storeId: string,
    channel: string,
    data: ConfigInput
  ): Promise<NotificationConfig>;
  async testConnection(
    storeId: string,
    channel: string
  ): Promise<{ success: boolean; error?: string }>;
  async deleteConfig(storeId: string, channel: string): Promise<void>;
}
```

Credentials are encrypted using the existing `ENCRYPTION_KEY` environment variable.

## API Routes

### Admin Routes (store_admin + super_admin)

```
GET    /stores/:storeId/notifications/configs          → Get all channel configs
GET    /stores/:storeId/notifications/configs/:channel  → Get specific channel config
PUT    /stores/:storeId/notifications/configs/:channel  → Upsert channel credentials
DELETE /stores/:storeId/notifications/configs/:channel  → Remove channel config
POST   /stores/:storeId/notifications/test/:channel     → Test connection
GET    /stores/:storeId/notifications/events            → Get event configs
PUT    /stores/:storeId/notifications/events            → Update event configs
GET    /stores/:storeId/notifications/logs              → Get notification logs (paginated)
GET    /stores/:storeId/notifications/stats             → Notification statistics
```

All routes require: `authenticate → authorize('store_admin', 'super_admin') → requireStoreAccess`
Channel-specific routes also check the feature toggle (`requireFeature` for the channel).

### Public Routes

```
POST /public/:storeId/push/subscribe    → Register push subscription
POST /public/:storeId/push/unsubscribe  → Remove push subscription
```

### Webhook Routes

```
GET  /webhooks/whatsapp  → Meta webhook verification
POST /webhooks/whatsapp  → WhatsApp delivery status updates
```

## Admin UI

### New Page: `/stores/[id]/notifications`

Gated by feature flags — sections only appear if the channel's feature toggle is enabled.

**WhatsApp Section** (if `whatsapp` feature enabled):

- Credential form: Phone Number ID, WABA ID, Access Token
- "Test Connection" button → sends test message to admin's number
- Status indicator (connected/disconnected)
- Delivery stats (sent, delivered, failed counts)

**SMS Section** (if `sms` feature enabled):

- Credential form: Unifonic App SID, Sender ID
- "Test Connection" button → sends test SMS to admin's number
- Status indicator

**Push Notifications Section** (if `push_notifications` feature enabled):

- Firebase Service Account JSON upload
- VAPID key display/generation
- Subscriber count
- Status indicator

**Event Configuration Table:**
| Event | WhatsApp | SMS | Push |
|-------|----------|-----|------|
| Order Confirmed | [✓] | [✓] | [✓] |
| Payment Success | [✓] | [ ] | [✓] |
| Order Shipped | [✓] | [✓] | [✓] |
| Order Delivered | [✓] | [ ] | [✓] |
| Order Cancelled | [✓] | [✓] | [✓] |
| Refund Processed | [✓] | [ ] | [✓] |

Each checkbox is independently toggleable. Only shows columns for enabled channels.

**Notification Log:**

- Table with recent notifications: timestamp, event, channel, recipient, status
- Filter by channel, event, status
- Pagination

## Web Storefront Changes

### Push Notification Permission

- In the storefront, if `push_notifications` feature is enabled, show a notification permission prompt
- On accept: register service worker push subscription → POST to `/public/:storeId/push/subscribe`
- On decline: no prompt again (stored in localStorage)

### Service Worker Update

- Update the existing ServiceWorkerRegistration component to handle push events
- Show native browser notifications with store branding

## Integration Points (Existing Code Changes)

### OrderService.create() (apps/api/src/services/order.service.ts)

After existing email sending (around line 299):

```typescript
// After email Promise.all
await notificationDispatcher.dispatch(storeId, 'order_confirmed', {
  customerName,
  orderNumber,
  total,
  customerPhone,
});
```

### OrderService.updateStatus()

At each status transition (around lines 417-463), add:

```typescript
await notificationDispatcher.dispatch(storeId, eventName, data);
```

### Payment Webhook Handler

After payment confirmation:

```typescript
await notificationDispatcher.dispatch(storeId, 'payment_success', data);
```

## Security

- **Credentials encrypted** in DB using existing ENCRYPTION_KEY (AES-256)
- **WhatsApp webhook verification** via Meta's X-Hub-Signature-256 header (HMAC-SHA256 of raw body). Must use raw body buffer, not parsed JSON.
- **Feature toggle check** before any notification attempt
- **Credentials check** before any notification attempt (no credentials = log skip reason explicitly, not silently)
- **Rate limiting** on webhook endpoints AND on dispatch (max 100 notifications/min per store to prevent abuse)
- **PII protection**: Phone numbers and emails are SHA-256 hashed in NotificationLog — no plaintext PII stored in logs
- **Idempotency**: Each notification gets a unique `idempotencyKey` (`{storeId}:{event}:{orderId}:{channel}:{timestamp}`). Duplicate sends are prevented by unique constraint.
- **Opt-out tracking**: If a customer blocks WhatsApp or replies STOP to SMS, mark them as opted out. Do NOT send further messages to opted-out customers.

## Cache Strategy

- NotificationConfig cached in Redis per store: `notification:config:{storeId}` (5min TTL)
- NotificationEventConfig cached: `notification:events:{storeId}` (5min TTL)
- Cache invalidated on config update

## Error Handling

- Queue failures: retry 3x with exponential backoff, then move to failed queue
- Provider errors: logged to NotificationLog with error details
- **Per-store circuit breakers**: `notification:{storeId}:whatsapp`, `notification:{storeId}:sms` — one store's provider failure doesn't affect others
- Notification failures NEVER block order creation (fire-and-forget with logging)
- **Out-of-order webhook status**: Use timestamp-based precedence. Only update status if new status timestamp > current status timestamp. Status hierarchy: queued < sent < delivered < read.
- **SMS bilingual**: Use customer's preferred language if known, fall back to store's default language setting
- **Log retention**: NotificationLog entries older than 90 days are eligible for cleanup (cron job or manual)

## Testing

- Unit tests for each service (WhatsApp, SMS, Push, Dispatcher)
- Mock provider APIs in tests
- Integration test: dispatch notification → verify queue populated → verify log created
- Test feature toggle gating: channel disabled → no queue entry
- Test event config: event disabled for channel → no queue entry

## npm Dependencies

- `firebase-admin` — Push notifications via FCM
- No new WhatsApp SDK — use raw fetch to Meta Graph API (simpler, fewer dependencies)
- No new SMS SDK — use raw fetch to Unifonic REST API

## Files to Create

| File                                                       | Responsibility                                   |
| ---------------------------------------------------------- | ------------------------------------------------ |
| `packages/shared/src/notifications.ts`                     | Event types, channel types, template definitions |
| `apps/api/src/services/notification-dispatcher.service.ts` | Orchestrator                                     |
| `apps/api/src/services/notification-config.service.ts`     | Credential CRUD + encryption                     |
| `apps/api/src/services/whatsapp.service.ts`                | Meta Cloud API calls                             |
| `apps/api/src/services/whatsapp-queue.service.ts`          | Redis queue for WhatsApp                         |
| `apps/api/src/services/sms.service.ts`                     | Unifonic API calls                               |
| `apps/api/src/services/sms-queue.service.ts`               | Redis queue for SMS                              |
| `apps/api/src/services/push.service.ts`                    | Firebase Admin SDK                               |
| `apps/api/src/routes/notification.routes.ts`               | Admin notification endpoints                     |
| `apps/admin/src/app/stores/[id]/notifications/page.tsx`    | Notification settings UI                         |
| `apps/web/src/components/PushNotificationPrompt.tsx`       | Push permission prompt                           |
| `tests/unit/notification.test.ts`                          | Unit tests                                       |
| `tests/e2e/notification.test.ts`                           | Integration tests                                |

## Files to Modify

| File                                               | Change                                               |
| -------------------------------------------------- | ---------------------------------------------------- |
| `packages/database/prisma/schema.prisma`           | Add 4 new models                                     |
| `apps/api/src/routes/index.ts`                     | Mount notification routes                            |
| `apps/api/src/services/order.service.ts`           | Add dispatcher calls                                 |
| `apps/api/src/routes/webhook.routes.ts`            | Add WhatsApp webhook                                 |
| `apps/api/src/config/index.ts`                     | No new env vars needed (per-store credentials in DB) |
| `apps/admin/src/app/stores/[id]/settings/page.tsx` | Add Notifications card                               |
| `apps/web/src/app/layout.tsx`                      | Add PushNotificationPrompt                           |
