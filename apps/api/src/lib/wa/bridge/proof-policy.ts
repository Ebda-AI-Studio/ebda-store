/**
 * Buyer-proof policy for the WhatsApp bridge (Ruling WA-BRIDGE-BIND-4). Secure by default: the proof is REQUIRED unless the
 * operator sets WA_BRIDGE_REQUIRE_BUYER_PROOF to the exact string "0" (explicit, deliberate opt-out). Unset, empty, "1", or any
 * other value means strict. Before BIND-4 an unset var was permissive (fail open), and no committed config set it.
 */
export const buyerProofRequired = (raw: string | undefined): boolean => raw !== '0';
