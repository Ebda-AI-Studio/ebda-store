# WA-RPC-5

Ruling WA-RPC-5 - `attachPaymentProof` records the customer's InstaPay screenshot reference in the audit trail (`order.instapay_proof_from_chat`, order-scoped, https URL only) for an order that has an InstaPay payment. It does not create an InstaPay receipt, because the receipt pipeline needs image bytes and the Meta media download is blocked on company papers. Follow-up WA-RPC-F2 stays blocked on company papers (Meta media). Cost if wrong: the merchant sees the proof link in the audit history, not in the receipt review screen, until F2.
