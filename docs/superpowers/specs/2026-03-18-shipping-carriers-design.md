# Phase 5: Shipping Carrier Integrations — Design Spec

## Overview

Full-auto shipping integration with iCarry (Kuwait local) and Aramex (GCC + international). When a store admin confirms an order, the system auto-creates a shipment with the configured carrier, gets a tracking number, updates the order, notifies the customer, and tracks delivery status via carrier webhooks. Per-store carrier credentials. Toggleable via `shipping_carriers` feature key.

## Decisions

- **Carriers:** iCarry (Kuwait local delivery) + Aramex (GCC + international)
- **Integration depth:** Full auto — order confirmed → auto-create shipment → tracking → webhooks → auto-deliver
- **Architecture:** Pluggable carrier interface — easy to add new carriers later
- **Per-store:** Each store configures their own carrier credentials + default carrier
- **Feature toggle:** `shipping_carriers` (already registered in Phase 0)

## Data Layer

### New Model: ShippingCarrierConfig

Per-store carrier credentials and settings.

```prisma
model ShippingCarrierConfig {
  id          String   @id @default(uuid())
  storeId     String   @map("store_id")
  carrier     String   // 'icarry' | 'aramex'
  credentials String   @default("") // Encrypted JSON
  enabled     Boolean  @default(false)
  isDefault   Boolean  @default(false) @map("is_default")
  settings    Json     @default("{}") // Default weight, pickup address, etc.
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")

  store Store @relation(fields: [storeId], references: [id], onDelete: Cascade)

  @@unique([storeId, carrier])
  @@index([storeId])
  @@map("shipping_carrier_configs")
}
```

**iCarry credentials:**

```json
{ "apiKey": "...", "merchantId": "..." }
```

**Aramex credentials:**

```json
{
  "accountNumber": "...",
  "accountPin": "...",
  "accountEntity": "...",
  "accountCountryCode": "KW",
  "username": "...",
  "password": "..."
}
```

### New Model: Shipment

Tracks individual shipments with carrier status.

```prisma
model Shipment {
  id                  String    @id @default(uuid())
  storeId             String    @map("store_id")
  orderId             String    @map("order_id")
  carrier             String    // 'icarry' | 'aramex'
  trackingNumber      String?   @map("tracking_number")
  trackingUrl         String?   @map("tracking_url")
  labelUrl            String?   @map("label_url")
  status              String    @default("created") // created | picked_up | in_transit | out_for_delivery | delivered | failed | returned | cancelled
  carrierShipmentId   String?   @map("carrier_shipment_id")
  pickupAddress       Json      @map("pickup_address")
  deliveryAddress     Json      @map("delivery_address")
  weight              Decimal?  @db.Decimal(8, 2)
  dimensions          Json?     // { length, width, height }
  estimatedDeliveryAt DateTime? @map("estimated_delivery_at")
  statusHistory       Json      @default("[]") @map("status_history") // [{status, timestamp, location?}]
  error               String?
  createdAt           DateTime  @default(now()) @map("created_at")
  updatedAt           DateTime  @updatedAt @map("updated_at")

  store Store @relation(fields: [storeId], references: [id], onDelete: Cascade)
  order Order @relation(fields: [orderId], references: [id], onDelete: Cascade)

  @@index([storeId])
  @@index([orderId])
  @@index([trackingNumber])
  @@index([storeId, status])
  @@map("shipments")
}
```

### Relations

Add to Store model:

```prisma
shippingCarrierConfigs ShippingCarrierConfig[]
shipments              Shipment[]
```

Add to Order model:

```prisma
shipment Shipment?
```

## Carrier Interface

Pluggable interface — each carrier implements the same contract:

```typescript
interface ShippingCarrierProvider {
  name: string;
  code: string; // 'icarry' | 'aramex'

  createShipment(
    config: CarrierCredentials,
    shipmentData: {
      orderId: string;
      orderNumber: string;
      pickupAddress: Address;
      deliveryAddress: Address;
      weight?: number;
      dimensions?: { length: number; width: number; height: number };
      items: { name: string; quantity: number; value: number }[];
      codAmount?: number; // Cash on delivery amount
      notes?: string;
    }
  ): Promise<{
    carrierShipmentId: string;
    trackingNumber: string;
    trackingUrl?: string;
    labelUrl?: string;
    estimatedDelivery?: Date;
  }>;

  trackShipment(
    config: CarrierCredentials,
    trackingNumber: string
  ): Promise<{
    status: ShipmentStatus;
    statusHistory: { status: string; timestamp: Date; location?: string }[];
    estimatedDelivery?: Date;
  }>;

  cancelShipment(config: CarrierCredentials, carrierShipmentId: string): Promise<boolean>;

  processWebhook(
    body: unknown,
    headers: Record<string, string>
  ): {
    trackingNumber: string;
    status: ShipmentStatus;
    timestamp: Date;
    location?: string;
  } | null;

  testConnection(config: CarrierCredentials): Promise<{ success: boolean; error?: string }>;
}

type ShipmentStatus =
  | 'created'
  | 'picked_up'
  | 'in_transit'
  | 'out_for_delivery'
  | 'delivered'
  | 'failed'
  | 'returned'
  | 'cancelled';
```

### Carrier Registry

```typescript
const CARRIER_REGISTRY: Record<string, ShippingCarrierProvider> = {
  icarry: new ICarryCarrier(),
  aramex: new AramexCarrier(),
};
```

New carriers added by implementing the interface and registering.

## iCarry Integration

### API Details

- **Base URL:** `https://api.icarry.com/v1` (or equivalent — research actual API)
- **Auth:** API key in header
- **Create shipment:** POST /orders — requires: merchant_id, pickup address, delivery address, item details
- **Track:** GET /orders/{id}/tracking
- **Cancel:** PUT /orders/{id}/cancel
- **Webhook:** Callback URL registered in iCarry dashboard — receives status updates

### Status Mapping

| iCarry Status | Normalized Status |
| ------------- | ----------------- |
| pending       | created           |
| assigned      | created           |
| picked_up     | picked_up         |
| on_the_way    | in_transit        |
| arrived       | out_for_delivery  |
| delivered     | delivered         |
| cancelled     | cancelled         |
| returned      | returned          |

### Kuwait-Specific

- Delivery areas: 6 governorates (Capital, Hawalli, Farwaniya, Mubarak Al-Kabeer, Ahmadi, Jahra)
- Same-day / next-day delivery typical
- COD (Cash on Delivery) support

## Aramex Integration

### API Details

- **Base URL:** `https://ws.aramex.net/ShippingAPI.V2` (REST endpoints)
- **Auth:** Account credentials in request body (not header)
- **Create shipment:** POST /Shipping/CreateShipments
- **Track:** POST /Tracking/TrackShipments
- **Cancel:** POST /Shipping/CancelShipments
- **Webhook:** Aramex Track Notifications (push updates)

### Status Mapping

| Aramex Status    | Normalized Status |
| ---------------- | ----------------- |
| CREATED          | created           |
| PICKED_UP        | picked_up         |
| IN_TRANSIT       | in_transit        |
| OUT_FOR_DELIVERY | out_for_delivery  |
| DELIVERED        | delivered         |
| RETURNED         | returned          |
| FAILED           | failed            |

### International Features

- Customs declarations for cross-border shipments
- Multiple service types: Express, Value Express, Economy
- Label generation (PDF)

## Shipping Service (Orchestrator)

```typescript
class ShippingService {
  // Auto-ship: called when order status → confirmed
  async createShipmentForOrder(
    storeId: string,
    orderId: string,
    carrierCode?: string
  ): Promise<Shipment>;

  // Manual ship: admin picks carrier and triggers
  async createShipment(storeId: string, orderId: string, carrierCode: string): Promise<Shipment>;

  // Track: called by polling cron or webhook
  async updateShipmentStatus(shipmentId: string): Promise<void>;

  // Cancel: admin cancels shipment
  async cancelShipment(shipmentId: string): Promise<void>;

  // Config management
  async getCarrierConfigs(storeId: string): Promise<ShippingCarrierConfig[]>;
  async upsertCarrierConfig(storeId: string, carrier: string, data: ConfigInput): Promise<void>;
  async setDefaultCarrier(storeId: string, carrier: string): Promise<void>;
  async testConnection(storeId: string, carrier: string): Promise<{ success: boolean }>;

  // Tracking poll cron
  startTrackingCron(intervalMs?: number): void;
  stopTrackingCron(): void;
}
```

### Auto-Ship Flow Detail

When `OrderService.updateStatus()` sets status to `confirmed`:

1. Check if `shipping_carriers` feature is enabled for store
2. Get store's default carrier config
3. If no carrier configured → skip (store uses manual shipping)
4. Build shipment data from order (delivery address, items, weight, COD if applicable)
5. Pickup address from carrier config settings
6. Call carrier API → create shipment
7. Create Shipment record in DB
8. Update Order: trackingNumber, status → 'shipped'
9. Dispatch notification: `order_shipped` event with tracking URL
10. On failure: log error, do NOT fail order confirmation. Admin can retry manually.

### Tracking Cron

Polls carrier APIs for shipments not yet delivered:

- Runs every 30 minutes
- Queries: `Shipment WHERE status NOT IN ('delivered', 'cancelled', 'returned') AND createdAt > 30 days ago`
- For each: call carrier trackShipment API, update status + history
- When status = 'delivered' → update Order status to 'delivered', notify customer
- Redis lock: `shipping:tracking` (TTL 120s)

## Webhook Endpoints

```
POST /webhooks/shipping/icarry   → ICarryCarrier.processWebhook()
POST /webhooks/shipping/aramex   → AramexCarrier.processWebhook()
```

Each webhook:

1. Parse carrier-specific payload
2. Extract tracking number + new status
3. Find Shipment by trackingNumber
4. Update Shipment status + history
5. If delivered → update Order status, notify customer
6. Always return 200

## API Routes

### Admin Routes

All use: `authenticate → authorize('store_admin', 'super_admin') → requireStoreAccess → requireFeature('shipping_carriers')`

```
GET    /stores/:storeId/shipping-carriers/configs              → List carrier configs
GET    /stores/:storeId/shipping-carriers/configs/:carrier      → Get carrier config
PUT    /stores/:storeId/shipping-carriers/configs/:carrier      → Upsert credentials
DELETE /stores/:storeId/shipping-carriers/configs/:carrier      → Remove config
POST   /stores/:storeId/shipping-carriers/test/:carrier         → Test connection
POST   /stores/:storeId/shipping-carriers/default/:carrier      → Set as default

POST   /stores/:storeId/orders/:orderId/ship                   → Create shipment for order
POST   /stores/:storeId/orders/:orderId/ship/cancel             → Cancel shipment
GET    /stores/:storeId/shipments                               → List shipments (paginated)
GET    /stores/:storeId/shipments/:id                           → Shipment detail with timeline
GET    /stores/:storeId/shipments/:id/track                     → Force-refresh tracking from carrier
```

### Public Routes

```
GET /public/:storeId/orders/:orderId/tracking → Tracking info for customer (requires order ownership via session/auth)
```

## Admin UI

### New Page: `/stores/[id]/shipping-carriers`

**Carrier Cards:**

- iCarry card: credentials form (API Key, Merchant ID), enable/disable toggle, "Set as Default" button, "Test Connection" button, status indicator
- Aramex card: credentials form (account number, PIN, entity, country, username, password), same controls
- Pickup address form (shared across carriers)

**Active Shipments Table:**

- Columns: order number, carrier, tracking number, status, created, estimated delivery
- Status badges with colors
- Click to view shipment timeline
- Filter by carrier, status

**Settings card** in `/stores/[id]/settings`: "Shipping Carriers" with truck icon

### Order Detail Enhancement

On the order detail page, add:

- Carrier name + tracking number
- "Track" link to carrier tracking page
- Shipment status timeline (created → picked up → in transit → delivered)
- "Ship Order" button if not yet shipped (choose carrier dropdown)
- "Cancel Shipment" button if shipment is active

## Storefront

### Order Tracking

On the customer's order detail page (`/account/orders/[id]`):

- Show shipment status timeline
- Tracking number with link to carrier tracking page
- Estimated delivery date
- Status updates in real-time (or on page load)

## Integration with Communication Hub

When shipment status changes to key milestones:

- `picked_up` → dispatch `order_shipped` notification (if not already sent)
- `out_for_delivery` → could dispatch notification (future enhancement)
- `delivered` → dispatch `order_delivered` notification

Uses existing `notificationDispatcher.dispatch()`.

## Error Handling

- Carrier API failures → logged, admin notified via socket, retry available
- Shipment creation failure → order stays at 'confirmed', admin can retry or ship manually
- Webhook processing errors → logged, return 200 (never retry webhooks)
- Tracking poll failures → skip, retry next cycle
- Missing carrier config → auto-ship skipped silently (store uses manual shipping)

## Caching

- Carrier configs cached in Redis: `shipping:config:{storeId}` (5min TTL)
- Cache invalidated on config changes
- Shipment data NOT cached (always fresh from DB)

## Security

- Carrier credentials encrypted with existing ENCRYPTION_KEY
- Webhook endpoints validate carrier-specific signatures where available
- Public tracking endpoint requires order ownership (session or auth)
- Rate limiting on webhook endpoints

## Files to Create

| File                                                        | Responsibility                                                 |
| ----------------------------------------------------------- | -------------------------------------------------------------- |
| `apps/api/src/services/shipping.service.ts`                 | Orchestrator: create/cancel/track shipments, config management |
| `apps/api/src/services/carriers/icarry.carrier.ts`          | iCarry API implementation                                      |
| `apps/api/src/services/carriers/aramex.carrier.ts`          | Aramex API implementation                                      |
| `apps/api/src/services/carriers/types.ts`                   | ShippingCarrierProvider interface + types                      |
| `apps/api/src/routes/shipping-carrier.routes.ts`            | Admin + public endpoints                                       |
| `apps/admin/src/app/stores/[id]/shipping-carriers/page.tsx` | Admin carrier config + shipments UI                            |
| `tests/unit/shipping.test.ts`                               | Unit tests                                                     |

## Files to Modify

| File                                                         | Change                                     |
| ------------------------------------------------------------ | ------------------------------------------ |
| `packages/database/prisma/schema.prisma`                     | Add ShippingCarrierConfig, Shipment models |
| `apps/api/src/routes/index.ts`                               | Mount shipping carrier routes              |
| `apps/api/src/routes/webhook.routes.ts`                      | Add iCarry + Aramex webhook endpoints      |
| `apps/api/src/index.ts`                                      | Start tracking cron                        |
| `apps/api/src/services/order.service.ts`                     | Trigger auto-ship on order confirmation    |
| `apps/admin/src/app/stores/[id]/settings/page.tsx`           | Add Shipping Carriers settings card        |
| `apps/web/src/app/account/orders/[id]/OrderDetailClient.tsx` | Add shipment tracking timeline             |
