import { z } from 'zod/v3';

// STORE-QA-62: every channel flag is OPTIONAL. The admin page edits SMS and push only (WhatsApp is the separate Ebda WhatsApp
// product) and never sends `whatsapp`, so a required `whatsapp: boolean` 400'd EVERY save. A flag that is not sent keeps its stored
// value (merged in the route below), never silently flipped.
export const eventConfigShape = z
  .object({
    event: z.string().min(1),
    whatsapp: z.boolean().optional(),
    sms: z.boolean().optional(),
    push: z.boolean().optional(),
    push_notifications: z.boolean().optional(),
  })
  .transform(v => ({
    event: v.event,
    whatsapp: v.whatsapp,
    sms: v.sms,
    // `push` wins when both are sent.
    push: typeof v.push === 'boolean' ? v.push : v.push_notifications,
  }));

/** Fill the flags the client did not send from what is stored (false for a never-configured event). */
export function mergeEventFlags(
  stored: Record<string, { whatsapp: boolean; sms: boolean; push: boolean }>,
  e: { event: string; whatsapp?: boolean; sms?: boolean; push?: boolean }
) {
  const cur = stored[e.event];
  return {
    whatsapp: e.whatsapp ?? cur?.whatsapp ?? false,
    sms: e.sms ?? cur?.sms ?? false,
    push: e.push ?? cur?.push ?? false,
  };
}
