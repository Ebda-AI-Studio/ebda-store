import { customerKeyOf, isGuestOrder } from './customer-key';
import { smsConsentPhoneKey } from './sms-consent';

/**
 * Ruling QA98-ALIAS-1: ONE customer grouping for every surface (list, detail, export, RFM, SMS consent, erasure, analytics).
 *
 * Stored keys never change (consent rows, RFM hashes and bookmarked links all hold `customerKeyOf` values). Instead guests who
 * are provably the same person are grouped at read time: two guest identities are linked when they share a lowercased email OR
 * a normalised FULL phone number (country code included), transitively. A group is addressed by its smallest member key, so the result does not
 * depend on the order orders arrive in. Registered customers are their own group (the user id); a guest with no contact is the
 * `guest:<orderId>` row, handled by the callers.
 *
 * Every consumer takes its grouping from `CustomerGroups`; no surface re-implements the linking.
 */

interface OrderLike {
  customerId?: string | null;
  customer?: { id?: string | null } | null;
  shippingAddress?: unknown;
}

/** One guest identity as it sits on an order: the order's own stored key plus the contact it carries. */
export interface GuestIdentity {
  /** `customerKeyOf` of the order (lowercased email, else the phone verbatim). */
  key: string;
  email: string;
  phone: string;
}

export interface CustomerGroup {
  /** Smallest member key: the Customers-page row id. */
  key: string;
  /** Every stored key a member order can carry (emails and phone spellings). */
  memberKeys: string[];
  emails: string[];
  /** Raw phones as stored on member orders. */
  phones: string[];
}

/**
 * The phone identity a guest group links on: the FULL number in digits with its country code (the same normalisation the SMS consent
 * gate uses, `smsConsentPhoneKey`: an Egyptian mobile in any spelling is one key, any other number keeps its country code, so
 * +965 12345678 and +91 6512345678 never meet). '' for something that cannot identify a person: under 8 digits, or an obvious
 * placeholder (the last 8 digits all the same, e.g. a manual order typed 01000000000), so manual orders do not collapse into one row.
 */
function groupPhoneKey(phone: unknown): string {
  if (typeof phone !== 'string') return '';
  const key = smsConsentPhoneKey(phone);
  if (!key || key.length < 8) return '';
  if (/^(\d)\1+$/.test(key.slice(-8))) return '';
  return key;
}

function identityOf(order: OrderLike): GuestIdentity | null {
  if (!isGuestOrder(order)) return null;
  const key = customerKeyOf(order);
  if (!key) return null;
  const a = (order.shippingAddress ?? {}) as Record<string, unknown>;
  return {
    key,
    email: typeof a.email === 'string' ? a.email.toLowerCase() : '',
    phone: typeof a.phone === 'string' ? a.phone : '',
  };
}

export class CustomerGroups {
  private readonly parent = new Map<string, string>();
  private readonly groups = new Map<string, CustomerGroup>();
  private readonly groupOfKey = new Map<string, CustomerGroup>();
  private readonly groupOfEmail = new Map<string, CustomerGroup>();
  private readonly groupOfPhone = new Map<string, CustomerGroup>();

  constructor(identities: Iterable<GuestIdentity>) {
    const list = [...identities];
    const find = (x: string): string => {
      let r = x;
      while (this.parent.get(r) !== r) r = this.parent.get(r)!;
      let c = x;
      while (c !== r) {
        const n = this.parent.get(c)!;
        this.parent.set(c, r);
        c = n;
      }
      return r;
    };
    const add = (x: string): void => {
      if (!this.parent.has(x)) this.parent.set(x, x);
    };
    const union = (a: string, b: string): void => {
      add(a);
      add(b);
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) this.parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
    };
    // Nodes: `e:<email>`, `p:<canonical phone>`, and `k:<key>` for an identity with neither a usable email nor a long phone.
    const nodesOf = (i: GuestIdentity): string[] => {
      const nodes: string[] = [];
      if (i.email) nodes.push(`e:${i.email}`);
      const cp = groupPhoneKey(i.phone);
      if (cp) nodes.push(`p:${cp}`);
      if (nodes.length === 0) nodes.push(`k:${i.key}`);
      return nodes;
    };
    for (const i of list) {
      const nodes = nodesOf(i);
      add(nodes[0]);
      for (let n = 1; n < nodes.length; n++) union(nodes[0], nodes[n]);
    }
    const byRoot = new Map<
      string,
      { keys: Set<string>; emails: Set<string>; phones: Set<string> }
    >();
    for (const i of list) {
      const root = find(nodesOf(i)[0]);
      const g = byRoot.get(root) ?? { keys: new Set(), emails: new Set(), phones: new Set() };
      g.keys.add(i.key);
      if (i.email) g.emails.add(i.email);
      if (i.phone) g.phones.add(i.phone);
      byRoot.set(root, g);
    }
    for (const [root, g] of byRoot) {
      const memberKeys = [...g.keys].sort();
      const group: CustomerGroup = {
        key: memberKeys[0],
        memberKeys,
        emails: [...g.emails].sort(),
        phones: [...g.phones].sort(),
      };
      this.groups.set(root, group);
      for (const k of memberKeys) this.groupOfKey.set(k, group);
      for (const e of group.emails) this.groupOfEmail.set(e, group);
      for (const p of group.phones) {
        const cp = groupPhoneKey(p);
        if (cp) this.groupOfPhone.set(cp, group);
      }
    }
  }

  static fromOrders(orders: Iterable<OrderLike>): CustomerGroups {
    const ids: GuestIdentity[] = [];
    for (const o of orders) {
      const i = identityOf(o);
      if (i) ids.push(i);
    }
    return new CustomerGroups(ids);
  }

  /** The group a guest member key belongs to (any spelling a member order can carry), or null. */
  groupOfMemberKey(key: string): CustomerGroup | null {
    return this.groupOfKey.get(key) ?? null;
  }

  /**
   * The Customers-page row key of an order: the user id for a registered customer, the group's smallest key for a guest, null for a
   * guest with no contact (the caller gives it its own `guest:<orderId>` row).
   */
  keyOf(order: OrderLike): string | null {
    const i = identityOf(order);
    if (!i) return customerKeyOf(order);
    return this.groupOfKey.get(i.key)?.key ?? i.key;
  }

  /** The row key of a guest contact (email and/or phone as stored), or null when it has none. */
  keyOfContact(contact: { email?: string | null; phone?: string | null }): string | null {
    const email = typeof contact.email === 'string' ? contact.email.toLowerCase() : '';
    const phone = typeof contact.phone === 'string' ? contact.phone : '';
    const key = email || phone;
    if (!key) return null;
    const g = this.groupsOfContact(contact).sort((a, b) => (a.key < b.key ? -1 : 1))[0];
    return g?.key ?? key;
  }

  /** The groups a contact (email and/or phone, any spelling) belongs to: zero, one, or two when the two never met. */
  groupsOfContact(contact: { email?: string | null; phone?: string | null }): CustomerGroup[] {
    const out = new Set<CustomerGroup>();
    const e = typeof contact.email === 'string' ? contact.email.trim().toLowerCase() : '';
    const g1 = e ? this.groupOfEmail.get(e) : undefined;
    if (g1) out.add(g1);
    const cp = groupPhoneKey(contact.phone);
    const g2 = cp ? this.groupOfPhone.get(cp) : undefined;
    if (g2) out.add(g2);
    return [...out];
  }

  /** Every stored key one row key stands for (a registered id stands for itself). */
  memberKeysOf(rowKey: string): string[] {
    return this.groupOfKey.get(rowKey)?.memberKeys ?? [rowKey];
  }
}
