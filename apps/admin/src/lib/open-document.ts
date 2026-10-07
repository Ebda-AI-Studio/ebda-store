import { apiFetch } from './api';

/**
 * Fetch a protected document (auth via cookie/Bearer through `apiFetch`) and
 * open it in a new tab through a blob URL. Returns false when the fetch fails.
 * The tab is opened synchronously (before the await) so popup blockers allow it.
 */
export async function openProtectedDocument(endpoint: string): Promise<boolean> {
  const tab = window.open('', '_blank');
  try {
    const res = await apiFetch(endpoint);
    if (!res.ok) throw new Error(String(res.status));
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    if (tab) tab.location.href = url;
    else window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return true;
  } catch {
    tab?.close();
    return false;
  }
}
