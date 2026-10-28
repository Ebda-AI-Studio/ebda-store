# PR65-MANUAL-CONVERSION

> Section: BOSTA-LIVE-READONLY (2026-10-08)

Ruling PR65-MANUAL-CONVERSION — new manual payment attachment requires server-owned manualHoldAdmitted set by order-creation admission; do not infer it from COD fee or trust provider input. Existing live same-provider manual retries return before this guard, preserving legacy instructions. Other legacy/gateway orders must place a fresh checkout to select COD/InstaPay. Evidence: Order has no persisted paymentMethod; current checkout submits its chosen provider at both steps, and retry creates a fresh order. A positive COD fee is not an admission proof, and free COD made the original switching bypass exploitable. Cost if wrong: undocumented clients relying on changing a gateway order to manual payment must restart checkout.
