# EBDA-MONEYA-2

> Section: 2026-10-08 — Money batch A: InstaPay proof, subscription billing fixes (branch `fix/money-a`, EBDA-MONEYA-\*)

Ruling EBDA-MONEYA-2 — The AI read is Gemini through the existing `callGemini` (failover keys, platform AI quota, usage recording), model `GEMINI_MODEL` defaulting to `gemini-flash-lite-latest` (the multimodal `*-latest` alias, never a versioned name), as an Inngest job (`instapay/receipt-extract`, retries 0) with a 25 s timeout. Any failure (queue down, quota, timeout, bad JSON, no key) sets `extraction_status=failed` and the payer types the fields (manual entry) — the read only PRE-FILLS. The prompt was recorded against two SYNTHETIC receipts in the two real layouts (sent / received; `tests/fixtures/instapay`, made-up names and numbers, none of Ahmad's screenshots); tests replay the recorded answers. Cost if wrong: on a layout the model misreads, the payer corrects the form and the approver sees `FIELDS_CORRECTED` / `LOW_CONFIDENCE`.
