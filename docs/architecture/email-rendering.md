# Transactional email rendering

Every customer, merchant and campaign email is `renderBrandedShell(content, store)`
(`apps/api/src/services/email.service.ts`) around a content template from
`apps/api/src/services/email-templates/`. The invoice email body is
`InvoiceService.generateInvoiceEmail` → `renderInvoiceEmailContent`
(`apps/api/src/services/invoice.service.ts`).

## Invariant: nothing depends on `<style>`

Gmail (web + the Android/iOS apps) and Outlook drop `<style>` blocks, a `<style>`
nested in the body, or any rule they cannot parse (CSS custom properties,
`color-mix()`, space-separated `hsl()`). An element sized only by a class then
renders at its natural size.

Incident, 2026-09-30: Pecannbee's invoice (ORD-TM67JC-2Q6XK) on the Gmail Android
app showed a 1600px logo twice, a 1200×1600 product photo several screens tall
and a loose "PAID" watermark. The emailed invoice was `generateInvoice()`, the
printable web page (its own `<html>`, `<head>` and `<style>`), nested in the
shell.

Rules, all in `email-templates/_layout.ts`:

- **Layout**: a presentation table `width="600"`, `style="width:100%;max-width:600px"`
  (`EMAIL_MAX_WIDTH`). The shell emits no `<style>` block.
- **Images**: always `emailImage()`, which sets a `width` attribute, the same width inline, and
  `max-width:100%`, plus a fixed `height` (thumbnails, `EMAIL_THUMB_SIZE` = 64) or
  `height:auto` (logo, `EMAIL_LOGO_WIDTH` = 160: its aspect ratio is unknown, and
  a fixed height would stretch it).
- **Colour**: solid hex only (`emailColor` converts theme HSL tokens, `emailTint`
  mixes the header tint). `<meta name="color-scheme" content="light only">` asks
  clients not to recolour; Gmail's forced dark mode may still invert.
- **Status**: a small `emailBadge()` pill. Never a positioned watermark.
- **Direction**: `dir` on `<html>`, the page table and the content cell. Alignment is
  physical (`left`/`right`, since Outlook ignores `start`/`end`). Templates write
  `text-align: end`/`start`, and `inlineEmailStyles` maps them per direction.
  Phone numbers and amounts are wrapped in `dir="ltr"`.
- **Templates** keep a small vocabulary (`h2`/`h3`/`p`/`ul`, `.button`, `.order-table`,
  `.total-row`, `.address-box`, `var(--brand)`) that `inlineEmailStyles` rewrites to
  inline styles inside the shell.

The printable invoice (admin `GET …/orders/:orderId/invoice` and public `GET …/orders/:id/invoice`) is a
browser page and keeps its `<style>`. Never email it.

Pinned by `tests/unit/email-client-safe-layout.test.ts`, which renders every
template, the invoice and a campaign in EN and AR (its header lists the mutation
proof).
