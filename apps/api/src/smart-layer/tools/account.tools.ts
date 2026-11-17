/**
 * Wave 2 (plan 4 C2): account. Declared with `change()` from ./kit.
 *   - profile_update (account.profile): routes/auth.routes.ts `PUT /auth/me` (any signed-in merchant user: `authenticate` only, no role list, no feature),
 *     which calls `AuthService.updateProfile(userId, data, { storeId: req.user.storeId })`. A merchant token carries no store id, so the tenant scope is `null`
 *     (the route passes the same). Only the user's OWN first name, last name and phone, exactly the route's fields.
 *     Never reachable (secrets/identity rules, `show_me_where` only): e-mail, password, MFA, passkeys, role, closing the account. The route has no language
 *     field, so there is no language argument.
 */
import { z } from 'zod/v3';
import type { ToolSpec } from '@ebda/shared/smart-layer';
import { AuthService } from '../../services/auth.service';
import { change, diffRows, f, pair, pick, shape } from './kit';

type Rec = Record<string, unknown>;
type ProfileArgs = { firstName?: string; lastName?: string; phone?: string };
const KEYS = ['firstName', 'lastName', 'phone'] as const;
const LABELS: Record<string, [string, string]> = {
  firstName: ['الاسم الأول', 'First name'],
  lastName: ['اسم العيلة', 'Last name'],
  phone: ['رقم التليفون', 'Phone'],
};

const base = shape<ProfileArgs>({
  firstName: f.str('Your first name (cannot be empty).', { max: 100 }),
  lastName: f.text('Your last name.', { max: 100 }),
  phone: f.text('Your phone number.', { max: 40 }),
});
const schema = {
  jsonSchema: base.jsonSchema,
  args: base.args.refine(o => KEYS.some(k => o[k] !== undefined), {
    message: 'send at least one field',
  }) as z.ZodType<ProfileArgs>,
};

const profileUpdate = change<ProfileArgs>({
  name: 'profile_update',
  capabilityId: 'account.profile',
  description:
    "Change the signed-in user's own first name, last name or phone number. It never changes the e-mail, password, two-step verification, role or closes the account: for those it can only show the screen.",
  schema,
  undo: 'reversible',
  gate: {}, // PUT /auth/me: `authenticate` only. A platform super admin is refused by the kit.
  audit: { action: 'user.assistant_profile_updated', resourceType: 'user' },
  state: async ctx => {
    const u = await AuthService.getProfile(ctx.userId, { storeId: null });
    return {
      ...pick(u as unknown as Rec, [...KEYS]),
      updatedAt: String((u as Rec).updatedAt ?? ''),
    };
  },
  describe: (_ctx, a, st) => {
    const keys = KEYS.filter(k => a[k] !== undefined);
    return {
      summary: pair('تعديل بياناتك الشخصية', 'Update your own profile'),
      rows: diffRows(LABELS, st as Rec, Object.fromEntries(keys.map(k => [k, a[k]]))),
      affectedCount: 1,
      restore: pick(st as Rec, keys),
    };
  },
  run: (ctx, a) => AuthService.updateProfile(ctx.userId, a, { storeId: null }),
  inverse: (_a, restore) => {
    const r = restore as Rec | null;
    if (!r) return null;
    // the route refuses an empty first name and treats "" as "leave it", so only restore what can be restored
    const args = Object.fromEntries(
      Object.entries(r).filter(([k, v]) => v !== null && !(k === 'firstName' && v === ''))
    );
    return Object.keys(args).length ? { tool: 'profile_update', args } : null;
  },
});

export function accountTools(): ToolSpec[] {
  return [profileUpdate];
}
