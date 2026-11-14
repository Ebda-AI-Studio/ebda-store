import { S, S_UNLINKED, S_UNKNOWN, BUYER } from './fake-port';
/** Ordered args for the Chat-agent context RPC (Ruling CHAT-AGENT-1). Expectations live in `tests/vectors/ebda-wa/bridge-chat-context-v1.json`. */
export const CHAT_CONTEXT_CASES: Array<{ name: string; method: string; args: unknown[] }> = [
  {
    name: 'meaning search with a budget',
    method: 'searchProducts',
    args: [S, 'هدية', { maxPriceMinor: 30000, limit: 5 }],
  },
  {
    name: 'search with no hit is ok + empty',
    method: 'searchProducts',
    args: [S, 'zzz', { limit: 5 }],
  },
  {
    name: 'search with a blank query is invalid',
    method: 'searchProducts',
    args: [S, ' ', { limit: 5 }],
  },
  {
    name: 'search of an unknown store is not_found',
    method: 'searchProducts',
    args: [S_UNKNOWN, 'x', { limit: 5 }],
  },
  { name: 'store policies', method: 'getStorePolicies', args: [S] },
  {
    name: 'store policies of an unlinked store is not_linked',
    method: 'getStorePolicies',
    args: [S_UNLINKED],
  },
  { name: 'customer profile by phone', method: 'getCustomerProfile', args: [S, BUYER.phoneE164] },
  {
    name: 'customer profile of an unknown phone is null, not an error',
    method: 'getCustomerProfile',
    args: [S, '+201999999999'],
  },
  { name: 'customer profile needs a valid phone', method: 'getCustomerProfile', args: [S, 'nope'] },
];
