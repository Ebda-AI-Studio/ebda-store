/** Client of the Ebda assistant routes (`/stores/:storeId/assistant/*`, apps/api/src/routes/assistant.routes.ts). */
import { apiGet, apiPost } from './api';

export type AssistantSegment =
  | { kind: 'text'; text: string }
  | { kind: 'cap'; capabilityId: string; label: string; appPath: string }
  | { kind: 'link'; href: string; text: string }
  | { kind: 'cite'; articleId: string; title: string; url: string };
export type AssistantStatus =
  | 'answered'
  | 'refused'
  | 'not_covered'
  | 'handoff'
  | 'off'
  | 'limited';
interface AssistantTurn {
  status: AssistantStatus;
  segments: AssistantSegment[];
  previews: unknown[];
  turnId: string;
}
interface StoredTurn {
  id: string;
  role: 'merchant' | 'assistant';
  text: string;
  at: number;
}

const base = (storeId: string) => `/api/v1/stores/${encodeURIComponent(storeId)}/assistant`;

export const getAssistantStatus = (storeId: string) =>
  apiGet<{ enabled: boolean }>(`${base(storeId)}/status`);
export const postTurn = (
  storeId: string,
  body: { conversationId: string; text: string; locale: 'ar' | 'en' }
) => apiPost<AssistantTurn>(`${base(storeId)}/turn`, body);
export const getConversation = (storeId: string, id: string) =>
  apiGet<{ items: StoredTurn[] }>(`${base(storeId)}/conversations/${encodeURIComponent(id)}`);
export const sendFeedback = (storeId: string, turnId: string, thumb: 'up' | 'down') =>
  apiPost<{ ok: boolean }>(`${base(storeId)}/feedback`, { turnId, thumb });

/** A registry screen path (`/stores/[id]/domain`) as this store's real path, or null when it still has a parameter we cannot fill (`[orderId]`). */
export function hrefForPath(appPath: string, storeId: string): string | null {
  // A registry path may carry a human note after the path ("/stores/[id] dashboard"): the path is what precedes the first space.
  const p = (appPath.split(/\s/)[0] ?? '').replace('[id]', encodeURIComponent(storeId));
  return p.startsWith('/') && !p.includes('[') && !p.includes('*') ? p : null;
}

/** Only an https address ever becomes a link, with no credentials: a reply the server let through is still never trusted to carry a script or data address. */
export function safeHref(href: string): string | null {
  try {
    const u = new URL(href);
    return u.protocol === 'https:' && !u.username && !u.password ? u.href : null;
  } catch {
    return null;
  }
}

const KEY = (storeId: string, userId: string) => `assistant.conversation.${storeId}.${userId}`;
/** The conversation id survives a reload, per STORE AND PERSON (cleared on sign-out by clearStoredSession); storage can throw (private window), then it is simply a new one. */
export function conversationIdFor(storeId: string, userId: string): string {
  try {
    const have = sessionStorage.getItem(KEY(storeId, userId));
    if (have) return have;
    const fresh = crypto.randomUUID();
    sessionStorage.setItem(KEY(storeId, userId), fresh);
    return fresh;
  } catch {
    return crypto.randomUUID();
  }
}
export function forgetConversation(storeId: string, userId: string): void {
  try {
    sessionStorage.removeItem(KEY(storeId, userId));
  } catch {
    /* nothing to forget */
  }
}
