# ICEBERG-PAY-COPY-1

> Section: Iceberg quick wins (2026-11-10)

**Ruling ICEBERG-PAY-COPY-1 - public payment copy states day-1 reality: COD and InstaPay for every store from day one, Paymob/Kashier/FawryPay only with the merchant's own account, Ebda's plan paid by InstaPay confirmed by hand.** Iceberg audit #9; provider-gate.ts enables a gateway only after the merchant's own credentials pass Test connection; admin billing copy confirms InstaPay plan payments. `tests/unit/marketing-payment-claims.test.ts` fails on any marketing line selling a gateway without the own-account wording. Cost if wrong: a merchant reads the softer wording as "no cards" and picks a competitor, while cards do work with their own account.
