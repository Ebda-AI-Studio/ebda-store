# EC-1

> Section: 2026-09-25

**Ruling EC-1 — the audience is newsletter subscribers only; customers are not a source.** The spec
allowed "customers with a marketing-consent flag if one exists". None exists: `Customer` has no
consent column and `Order.smsOptIn` is SMS-only and per order (`schema.prisma`, grep "consent" /
"marketing"). Having bought once is not consent to marketing email. A recipient's `customer_id` is
linked for display only and never widens the audience. Cost if wrong: merchants reach fewer people
than they expect until a checkout email-consent checkbox exists — a reach cost, never a consent
breach.
