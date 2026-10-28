# ID-5

> Section: Lifecycle emails and referral attribution (2026-10-22, branch `feat/lifecycle-emails`)

Ruling ID-5 (2026-10-24) - merchants re-login once at the identity cutover. The refresh cookie moves from api.ebda.app to accounts.ebda.app and browsers cannot transfer cookies across hosts; production has 6 admin users and 12 refresh tokens. Cost if wrong: one extra login per merchant.
