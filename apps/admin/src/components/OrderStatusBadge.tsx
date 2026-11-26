'use client';

import { useT } from '@/i18n/useT';
import {
  STATUS_FAMILIES,
  TONE_CLASSES,
  getStatusEntry,
  type StatusFamily,
} from '@/lib/status-tones';

interface OrderStatusBadgeProps {
  /** Raw status value; looked up in the family's entry of the shared registry (`@/lib/status-tones`). */
  status: string;
  /** Which status vocabulary the value belongs to. Defaults to the order lifecycle. */
  family?: StatusFamily;
  /** Override the i18n namespace the label is read from (defaults to the family's own). */
  namespace?: string;
  /** Rendered instead of the translated label. */
  label?: string;
}

/**
 * THE status badge for the whole merchant admin: tone + icon + text from the shared registry, so one status is one
 * colour everywhere and colour is never the only signal (icon and text always render). A status the registry does not
 * know yet renders a neutral pill with its raw value, so a new backend state is visible rather than lost.
 */
export function OrderStatusBadge({
  status,
  family = 'order',
  namespace,
  label,
}: OrderStatusBadgeProps) {
  const ns = namespace ?? STATUS_FAMILIES[family].labelNamespace ?? 'orders.status';
  const t = useT(ns);
  const { tone, icon: Icon } = getStatusEntry(family, status);
  const text = label ?? (t.has(status) ? t(status) : status);

  return (
    <span
      data-status-tone={tone}
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${TONE_CLASSES[tone]}`}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      {text}
    </span>
  );
}
