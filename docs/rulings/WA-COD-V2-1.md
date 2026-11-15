# WA-COD-V2-1 - richer COD confirmation fields (contract v1.6)

Ruling WA-COD-V2-1 - `order.cod_confirmation_requested` gains five OPTIONAL fields (envelope stays v1, an older Chat ignores them): `storeName` (header, max 60), `shippingAddressLine` (one line, max 300), `itemCount`, `orderUrlSuffix` (`account/orders/<orderId>`) and `storefrontOrigin`.

- The order link is the existing customer order page. The id is a v4 UUID, the page needs the customer's own sign-in and `GET /public/orders/:id` answers 403 to anyone else, so the link alone reveals nothing. No view token travels in a URL (SEC-15).
- `shippingAddressLine` is PII for the same customer only; it is never logged (`tests/unit/wa-store-events-producer.test.ts`).
- A failed store read drops the extras; the plain request still goes.
- The contract file is mirrored byte for byte in ebda-whatsapp (`src/core/api/store-events.ts`); `tests/unit/wa-contract-pin.test.ts` pins its sha256.

Cost if wrong: a guest (no account) tapping the button lands on a sign-in page instead of an order view; the confirm/cancel quick replies still work.
