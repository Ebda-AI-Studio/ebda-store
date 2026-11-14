/**
 * The searcher identity the Chat bridge hands to the storefront's query-embed gate (embed-budget.ts: no searcher = no embed).
 * Prefixed `wa-chat:<store>` so it can never collide with a storefront `ip:` bucket (Chat cannot spend a shopper's per-IP minute, and a
 * shopper cannot spend Chat's). Chat passes an opaque per-shopper id (a hash it already holds, never a phone); without one the whole
 * store's Chat traffic shares ONE bucket. Either way the per-minute searcher cap and the store/platform DAILY caps still bound spend, so
 * Chat can never exhaust more of a store's embed budget than the same number of storefront searches (Ruling CHAT-AGENT-6).
 */
export const CHAT_SEARCHER_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function chatSearcherId(storeId: string, opaque?: string): string {
  return opaque !== undefined && CHAT_SEARCHER_RE.test(opaque)
    ? `wa-chat:${storeId}:${opaque}`
    : `wa-chat:${storeId}`;
}
