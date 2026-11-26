import { z } from 'zod/v3';

/**
 * POST /admin/users body. Platform administrators are operator-only (Ruling ID-12; created by the secure
 * bootstrap script, never by this endpoint), so `role` can only be `store_admin`.
 */
export const adminInviteSchema = z.object({
  email: z.string().email().max(255),
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  /** Ignored: the invitee sets their own password from the mailed link (kept so older clients still validate). */
  password: z.string().min(8).max(255).optional(),
  role: z.literal('store_admin'),
});

export const ROLE_NOT_ALLOWED_MESSAGE = {
  messageAr:
    'الدور ده مينفعش يتضاف من هنا. مديري المنصة بيتضافوا من خلال تهيئة الأدمن الآمنة، والفورمة دي لأصحاب المتاجر بس.',
  messageEn:
    'This role cannot be added here. Platform admins are added through the secure admin bootstrap; this form only invites store admins.',
};

export type AdminInviteResult =
  | { ok: true; data: z.infer<typeof adminInviteSchema> }
  | { ok: false; body: { success: false; error: Record<string, unknown> } }
  | { ok: 'generic'; error: z.ZodError };

/** A wrong role gets its own field-specific, bilingual 400; any other failure falls through to the shared handler. */
export function parseAdminInvite(input: unknown): AdminInviteResult {
  const parsed = adminInviteSchema.safeParse(input);
  if (parsed.success) return { ok: true, data: parsed.data };
  const roleIssue = parsed.error.issues.some(i => i.path[0] === 'role');
  if (!roleIssue || parsed.error.issues.some(i => i.path[0] !== 'role')) {
    return { ok: 'generic', error: parsed.error };
  }
  return {
    ok: false,
    body: {
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: ROLE_NOT_ALLOWED_MESSAGE.messageEn,
        details: { role: [ROLE_NOT_ALLOWED_MESSAGE.messageEn], ...ROLE_NOT_ALLOWED_MESSAGE },
      },
    },
  };
}
