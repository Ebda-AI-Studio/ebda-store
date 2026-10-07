# Security Policy

Ebda takes the security of the Ebda platform and the
merchant stores it hosts seriously. This document describes how to report a
vulnerability and what to expect.

## Reporting a vulnerability

- **Email:** [security@ebda.app](mailto:security@ebda.app)
- Machine-readable contact: [`/.well-known/security.txt`](https://ebda.app/.well-known/security.txt)
  (RFC 9116), served on `ebda.app`, `store.ebda.app`, and
  `orders.ebda.app`.

Please include: the affected URL/endpoint, steps to reproduce, and the impact
you believe it has. Reports in English or Arabic are both fine.

## What to expect

| Stage                  | Commitment                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------- |
| Acknowledgement        | Within 48 hours                                                                       |
| Triage + severity      | Within 5 business days, per the severity matrix in `docs/INCIDENT.md` (P0–P3)         |
| Fix or mitigation plan | Communicated with the triage result; P0/P1 issues are worked immediately              |
| Disclosure             | Coordinated — we ask that you give us reasonable time to fix before public disclosure |

There is currently no paid bug-bounty program. Good-faith reports are always
credited on request.

## Scope

- `*.ebda.app` (storefront, admin, orders apps and the API)
- Merchant storefronts served by this platform on custom domains

Out of scope: denial-of-service testing, spam/social engineering of merchants
or staff, and third-party services we integrate with but do not operate
(payment gateways, analytics providers) — report those to the vendor.

## Safe harbor

We will not pursue action against researchers who act in good faith: access
only what is needed to demonstrate the issue, avoid privacy violations and
data destruction, and report promptly.

## Security posture

A buyer-shareable overview of encryption, scanning cadence, incident response,
data residency, and backups lives at
[`docs/security/security-overview.md`](docs/security/security-overview.md).
