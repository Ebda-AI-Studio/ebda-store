# Order notification channels and alert classes

Source: code on `main` (2026-11-11) + production logs for order ORD-TOBCT4-DRHWY (QA store, 01:15Z). "Live" = verified from code or logs; anything else says so.

## Shopper (order placed / shipped / delivered)

| Channel  | Mechanism                                                                                                                 | Needs                                                                                                                  | Status                                                                                                                                         |
| -------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Email    | `EmailService.sendOrderConfirmation` etc. -> `emailQueue.enqueue` -> Cloudflare Email Service                             | A valid recipient. Optional at checkout, so a guest may have none                                                      | Live. Skipped (never enqueued) when no valid address                                                                                           |
| SMS      | `notificationDispatcher.dispatch` -> `smsQueue` -> Unifonic (`sms.service.ts`)                                            | Feature flag `sms` on the store + the MERCHANT's own Unifonic credentials per store + shopper phone + per-event config | Provider exists (Unifonic, bring-your-own). Sends nothing unless the store configured it. QA store: not configured (inferred: no SMS delivery) |
| WhatsApp | NOT a dispatcher channel. Ebda Chat (separate repo `ebda-whatsapp`). Order emails carry a free `wa.me` click-to-chat link | Meta business verification (blocked on company papers)                                                                 | Not live                                                                                                                                       |
| Push     | OneSignal web push to shoppers is not part of the order flow                                                              | -                                                                                                                      | Not an order channel                                                                                                                           |

## Merchant (new order)

| Channel             | Mechanism                                                        | Needs                                            | Status                                                                                                                                    |
| ------------------- | ---------------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Owner email         | `send-owner-invoice` step in `order-created.ts` -> invoice email | Opt-in `settings.orderInvoiceEmail` on the store | Live only for stores that set it. QA store: NOT VERIFIED (log lines truncated in the aggregate view)                                      |
| Admin push          | `onesignal-admin-push` / `orders-app-push` (OneSignal)           | `ONESIGNAL` app id + REST key                    | NOT configured in production: log `Orders OneSignal not configured (hasAppId:false, hasRestKey:false)` at 01:15:06Z. Merchant got no push |
| Admin bell (in-app) | Socket event to the admin                                        | Admin tab open                                   | Code path exists; not verified for this order                                                                                             |
| SMS to merchant     | Same dispatcher                                                  | Same as shopper SMS                              | Same                                                                                                                                      |

## Alert classes (Telegram via `sendAlert`)

| Class                                                                                                      | Level | Example                                                          | Why                                                   |
| ---------------------------------------------------------------------------------------------------------- | ----- | ---------------------------------------------------------------- | ----------------------------------------------------- |
| Provider-side permanent failure (sender not verified, binding missing, unknown provider error, Redis loss) | P1    | `email.queue.permanent_failure`                                  | Platform outage; operator must act                    |
| Bad recipient address (provider `E_VALIDATION_ERROR: Invalid email address`)                               | none  | Dead-letter entry gets `failureClass: "bad_recipient"`; warn log | Customer data. Recorded, replayable list, never paged |
| Suppressed recipient (hard bounce / complaint)                                                             | none  | `E_RECIPIENT_SUPPRESSED`                                         | Routine                                               |
| No valid recipient at enqueue                                                                              | none  | `enqueue` returns `skipped-invalid-recipient`, warn log          | Nothing to send                                       |

Enforcement: `validRecipients` (Zod email) in `lib/undeliverable-email.ts` runs in `emailQueue.enqueue` (the single choke point for every queued email: order, status, invoice, abandoned cart, back-in-stock, review, lifecycle, provider activation) and in `sendMail` via `deliverableOnly` (every direct send).

## Ruling NOTIF-SMS-1 - no SMS provider; email is the only shopper channel until WhatsApp

Ruling NOTIF-SMS-1 - Ahmad decided (2026-11-11): Ebda adds NO SMS provider. Shopper order messages (placed / shipped / delivered) wait for WhatsApp through Ebda Chat (`ebda-whatsapp`), once Meta business verification is done. Until then email is the only shopper channel, and it is sent only when a valid address exists (guests may leave it empty; nothing is queued then). The existing per-store bring-your-own Unifonic code is unchanged and is not a platform channel. Cost if wrong: shoppers who give a phone but no email get no order notice until WhatsApp is live.

Shopper channel table above is read with this ruling: the SMS row is "merchant-configured only, not offered by Ebda"; the WhatsApp row is "planned, blocked on Meta verification".
