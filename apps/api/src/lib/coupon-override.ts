/**
 * Admin/manual-order coupon override — owner decision 2026-09-25 (#1370),
 * ruling M-OVR-1 in docs/RULINGS.md.
 *
 * An admin order enforces a coupon's rules by default. A store_admin or
 * super_admin may apply it outside them with a reason; the override is
 * recorded as an orderEvent (durable, in the order transaction) and an
 * audit-log row (merchant-only on the order timeline).
 *
 * Constants only, no imports: route, service and tests can all read them
 * without pulling in (or mocking) a service module.
 */

/** Roles allowed to override. Staff can place manual orders but not override. */
export const COUPON_OVERRIDE_ROLES: readonly string[] = ['store_admin', 'super_admin'];

/** orderEvent.toStatus recording the override. */
export const COUPON_OVERRIDE_EVENT = 'coupon_override';

/** auditLog.action for the same override. */
export const COUPON_OVERRIDE_AUDIT_ACTION = 'order.coupon_override';
