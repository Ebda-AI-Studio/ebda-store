/**
 * ONE status vocabulary for the merchant admin: every status in every family maps to a tone + an icon.
 *
 * Why this exists: the same word used to render in different colours on different screens (a shipped order was
 * violet on /orders and blue on the dashboard) and two different meanings shared a colour (InstaPay "money not
 * confirmed" and "shipped" were both violet). Colour is also never the only signal: every badge shows an icon and
 * the translated text (WCAG 1.4.1).
 *
 * Rules (enforced by status-tones.test.ts):
 *  - inside ONE family no two statuses share a tone;
 *  - a surface never defines its own status colour map; it renders <StatusBadge family=... status=... />;
 *  - tokens only, no raw palette classes (tests/unit/admin-design-tokens.test.ts).
 *
 * Labels stay in the i18n catalogues (en + ar) under each family's `labelNamespace`; the test checks every
 * registry key has a label in both locales so no status can render as a raw key.
 */
import {
  AlertTriangle,
  Archive,
  Ban,
  BadgeCheck,
  Banknote,
  CheckCircle2,
  CircleDashed,
  Clock,
  FileEdit,
  FileText,
  Hourglass,
  Mail,
  MailCheck,
  MailX,
  PackageCheck,
  PackageOpen,
  PackageSearch,
  PauseCircle,
  PlayCircle,
  RotateCcw,
  Search,
  Send,
  ShieldAlert,
  ShoppingCart,
  Sparkles,
  Star,
  Truck,
  Undo2,
  Wallet,
  XCircle,
  Bot,
  Inbox,
  Receipt,
  Loader2,
  type LucideIcon,
} from 'lucide-react';

type StatusTone =
  | 'neutral'
  | 'inactive'
  | 'success'
  | 'warning'
  | 'info'
  | 'danger'
  | 'brand'
  | 'outline'
  | 'solid';

/** Pill classes per tone, design tokens only (admin-design-tokens guard). outline + solid give the 8-step order lifecycle its 7th and 8th distinct looks. */
export const TONE_CLASSES: Record<StatusTone, string> = {
  neutral: 'bg-muted text-foreground',
  inactive: 'bg-muted text-muted-foreground',
  success: 'bg-success/10 text-success-ink dark:bg-success/30 dark:text-success-ink',
  warning: 'bg-warning/10 text-warning-ink dark:bg-warning/30 dark:text-warning-ink',
  info: 'bg-info/10 text-info-ink dark:bg-info/30 dark:text-info-ink',
  danger: 'bg-destructive/10 text-destructive-ink dark:bg-destructive/30 dark:text-destructive-ink',
  brand: 'bg-primary/10 text-primary-ink dark:bg-primary/30 dark:text-primary-ink',
  // Two extra looks built from tokens only (no raw palette): an outlined info chip and a solid night chip.
  outline: 'bg-card text-info-ink ring-1 ring-inset ring-info/40',
  solid: 'bg-foreground text-background',
};

interface StatusEntry {
  tone: StatusTone;
  icon: LucideIcon;
}

const e = (tone: StatusTone, icon: LucideIcon): StatusEntry => ({ tone, icon });

/**
 * family -> { labelNamespace, statuses }. `labelNamespace` is the i18n namespace holding `<status>` labels.
 */
export const STATUS_FAMILIES = {
  /** Order lifecycle. `awaiting_payment_confirmation` = InstaPay money not confirmed yet. */
  order: {
    labelNamespace: 'orders.status',
    statuses: {
      pending: e('warning', Clock),
      awaiting_payment_confirmation: e('brand', Hourglass),
      confirmed: e('outline', BadgeCheck),
      processing: e('info', PackageOpen),
      shipped: e('solid', Truck),
      delivered: e('success', PackageCheck),
      cancelled: e('danger', XCircle),
      refunded: e('neutral', Undo2),
    },
  },
  /** Payment state of an order. */
  payment: {
    labelNamespace: 'orders.status',
    statuses: {
      unpaid: e('warning', Wallet),
      awaiting_payment_confirmation: e('brand', Hourglass),
      paid: e('success', CheckCircle2),
      refunded: e('neutral', Undo2),
    },
  },
  /** Where an order came from (not a lifecycle state, so it is deliberately neutral). */
  orderSource: {
    labelNamespace: null,
    statuses: {
      agent: e('neutral', Bot),
    },
  },
  shipment: {
    labelNamespace: 'shipping.carriers.shipments.statuses',
    statuses: {
      created: e('neutral', FileText),
      picked_up: e('info', PackageSearch),
      in_transit: e('solid', Truck),
      out_for_delivery: e('brand', Send),
      delivered: e('success', PackageCheck),
      failed: e('danger', AlertTriangle),
      returned: e('warning', Undo2),
      cancelled: e('inactive', Ban),
    },
  },
  /** Creating the carrier label (internal step before a shipment exists). */
  shipmentLabel: {
    labelNamespace: 'shipping.carriers.shipments.statuses',
    statuses: {
      creating: e('neutral', Loader2),
      creation_failed: e('danger', AlertTriangle),
    },
  },
  return: {
    labelNamespace: 'returns.status',
    statuses: {
      pending: e('warning', Clock),
      approved: e('outline', BadgeCheck),
      rejected: e('danger', XCircle),
      shipped: e('solid', Truck),
      received: e('info', Inbox),
      inspecting: e('brand', Search),
      completed: e('success', CheckCircle2),
      cancelled: e('inactive', Ban),
    },
  },
  abandonedCart: {
    labelNamespace: 'abandonedCarts.status',
    statuses: {
      pending: e('warning', ShoppingCart),
      step1_sent: e('info', Mail),
      step2_sent: e('outline', Mail),
      step3_sent: e('solid', Mail),
      recovered: e('success', CheckCircle2),
      expired: e('neutral', Clock),
    },
  },
  /** Delivery state of a customer notification. */
  notification: {
    labelNamespace: 'notifications.log.status',
    statuses: {
      pending: e('neutral', CircleDashed),
      queued: e('info', Send),
      sent: e('outline', MailCheck),
      delivered: e('success', CheckCircle2),
      failed: e('danger', MailX),
    },
  },
  campaign: {
    labelNamespace: 'campaigns.status',
    statuses: {
      draft: e('neutral', FileEdit),
      scheduled: e('outline', Clock),
      sending: e('warning', Send),
      sent: e('success', CheckCircle2),
      cancelled: e('inactive', Ban),
      failed: e('danger', XCircle),
    },
  },
  campaignRecipient: {
    labelNamespace: 'campaigns.recipientStatus',
    statuses: {
      queued: e('info', Clock),
      sent: e('success', MailCheck),
      failed: e('danger', MailX),
      bounced: e('warning', AlertTriangle),
      unsubscribed: e('inactive', Ban),
    },
  },
  codReconciliation: {
    labelNamespace: 'codReconciliation.statuses',
    statuses: {
      awaiting: e('neutral', Hourglass),
      flagged: e('solid', ShieldAlert),
      partial: e('warning', Banknote),
      settled: e('success', CheckCircle2),
      over_remitted: e('brand', Banknote),
      mismatch: e('danger', ShieldAlert),
    },
  },
  lifecycleEmail: {
    labelNamespace: 'lifecycleEmails',
    statuses: {
      sent: e('success', MailCheck),
      skipped: e('inactive', PauseCircle),
      failed: e('danger', MailX),
      pending: e('neutral', Clock),
    },
  },
  bankStatement: {
    labelNamespace: 'finance.bankRec.statusLabels',
    statuses: {
      pending: e('warning', Clock),
      reconciling: e('info', PlayCircle),
      reconciled: e('success', CheckCircle2),
    },
  },
  purchaseOrder: {
    labelNamespace: 'stock.purchaseOrders.statuses',
    statuses: {
      draft: e('neutral', FileEdit),
      sent: e('info', Send),
      partial: e('warning', PackageOpen),
      received: e('success', PackageCheck),
      cancelled: e('inactive', Ban),
    },
  },
  affiliate: {
    labelNamespace: 'affiliates.list.status',
    statuses: {
      pending: e('warning', Clock),
      approved: e('success', CheckCircle2),
      rejected: e('danger', XCircle),
      suspended: e('neutral', PauseCircle),
    },
  },
  /** Platform user account state. */
  user: {
    labelNamespace: 'users.detail.statusLabels',
    statuses: {
      active: e('success', CheckCircle2),
      inactive: e('inactive', PauseCircle),
      suspended: e('danger', Ban),
    },
  },
  /** Catalogue state of a product. */
  product: {
    labelNamespace: 'products.list.status',
    statuses: {
      active: e('success', CheckCircle2),
      draft: e('warning', FileEdit),
      archived: e('inactive', Archive),
    },
  },
  /** The merchant's own Ebda subscription (billing page). */
  subscription: {
    labelNamespace: 'billing.status',
    statuses: {
      active: e('success', CheckCircle2),
      trialing: e('info', Sparkles),
      comped: e('outline', Star),
      awaiting_payment: e('warning', Hourglass),
      past_due: e('danger', AlertTriangle),
      canceled: e('inactive', Ban),
      none: e('neutral', CircleDashed),
    },
  },
  /** In-app notification bell item types. */
  notificationType: {
    labelNamespace: null,
    statuses: {
      new_order: e('success', ShoppingCart),
      new_review: e('warning', Star),
      new_return: e('brand', Undo2),
      low_stock: e('danger', AlertTriangle),
      order_status: e('info', Receipt),
      return_status: e('outline', RotateCcw),
    },
  },
} as const satisfies Record<
  string,
  { labelNamespace: string | null; statuses: Record<string, StatusEntry> }
>;

export type StatusFamily = keyof typeof STATUS_FAMILIES;

/** Fallback for a status the backend added before the registry knew it: neutral + generic icon, never a crash. */
export const UNKNOWN_STATUS: StatusEntry = { tone: 'neutral', icon: CircleDashed };

export function getStatusEntry(family: StatusFamily, status: string): StatusEntry {
  const statuses: Record<string, StatusEntry> = STATUS_FAMILIES[family].statuses;
  // Own-property check: API strings like "constructor" / "__proto__" must not reach Object.prototype members.
  return Object.prototype.hasOwnProperty.call(statuses, status) ? statuses[status] : UNKNOWN_STATUS;
}

export function isKnownStatus(family: StatusFamily, status: string): boolean {
  return Object.prototype.hasOwnProperty.call(STATUS_FAMILIES[family].statuses, status);
}
