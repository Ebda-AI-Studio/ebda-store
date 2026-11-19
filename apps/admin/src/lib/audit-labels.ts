/**
 * Human labels for the super-admin audit viewer (STORE-QA-17). The API writes machine action keys
 * ("audit.platform_viewed", "STORE_ACCESS", "product.updated") and a `resourceType`; a reader must never see them raw.
 * The key is normalised once here and looked up in `audit.actionLabels.<key>` / `audit.entityLabels.<type>`;
 * an unknown key renders the generic "other" label (the raw key stays in the expandable details only).
 */
export function auditKey(raw: string | null | undefined): string {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

interface Lookup {
  has: (key: string) => boolean;
  (key: string): string;
}

export function auditActionLabel(raw: string | null | undefined, t: Lookup): string {
  const k = auditKey(raw);
  return k && t.has(`actionLabels.${k}`) ? t(`actionLabels.${k}`) : t('actionOther');
}

export function auditEntityLabel(raw: string | null | undefined, t: Lookup): string {
  const k = auditKey(raw);
  return k && t.has(`entityLabels.${k}`) ? t(`entityLabels.${k}`) : t('entityOther');
}

/** Actor shown on a row: full name, else email, else null (the caller prints "System"). */
export function auditActorName(
  user: { firstName?: string | null; lastName?: string | null; email?: string | null } | null
): string | null {
  if (!user) return null;
  const name = `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim();
  return name || user.email || null;
}
