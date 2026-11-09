# Studio enquiry (marketing contact form)

Source: Ahmad 2026-11-03. Ruling: CONTACT-FORM-1 (`docs/rulings/CONTACT-FORM-1.md`).

`POST /api/v1/public/contact/enquiry`, public (no auth, CSRF-exempt under `/public/`, CORS from `https://ebda.app`). Used by the form on `/contact` and `/en/contact`. Nothing is stored.

| Field     | Rules                                                                                                                      |
| --------- | -------------------------------------------------------------------------------------------------------------------------- |
| `name`    | required, 100 chars max, control characters stripped                                                                       |
| `company` | optional, 120 chars max                                                                                                    |
| `phone`   | required; Egyptian mobile (`01012345678`, `+20...`, Arabic digits) or `+` international; stored as E.164 in the mail       |
| `email`   | required, 254 max, lower-cased                                                                                             |
| `topic`   | `store-support`, `chat-support`, one of the three `BRAND.services` category ids (`software`, `ai`, `training`), or `other` |
| `message` | required, 10 to 4000 chars                                                                                                 |
| `consent` | must be true (`true`, `"on"`, `"true"`, `"1"`); links the privacy policy                                                   |
| `lang`    | `ar` (default) or `en`; picks the receipt language and the no-JavaScript redirect                                          |
| `website` | honeypot: must stay empty (a filled one gets a fake success and no email)                                                  |
| `fillMs`  | optional; milliseconds the page was open; under 2500 is refused (`TOO_FAST`)                                               |

Responses: `200 {success:true,data:{requestId}}`; `400 VALIDATION_ERROR` with `error.fields` (field to code, never user text); `400 TOO_FAST`; `429 RATE_LIMITED` (5/hour per IP and 5/hour per email); `502 SEND_FAILED` (email send failed, a P1 alert `public.contact.enquiry` is raised, the page tells the visitor to use WhatsApp or email). A urlencoded post that does not ask for JSON (the form without JavaScript) gets `303` to `https://ebda.app[/en]/contact/#sent` or `#send-failed` instead.

Delivery: `EmailService.sendContactEnquiry` to `BRAND.supportEmail` (Reply-To = the visitor), then `sendContactEnquiryReceipt` to the visitor in `lang`. Direct and awaited, never queued. Logs carry `{requestId, outcome}` only. No new env var and no new secret: the existing `EMAIL` send binding and Telegram alert variables are used. Turnstile is not used (no key in the repo); add a bot challenge if abuse appears.
