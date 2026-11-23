/**
 * Ebda's own acquisition funnel: one table maps each step to its Meta name and PostHog name.
 * landing -> signup -> store created -> paid, in PostHog order:
 *   page_view -> signup_submitted -> registration_completed -> store_created -> subscription_paid
 */
export type FunnelStep =
  | 'page_view'
  | 'pricing_viewed'
  | 'contact_submitted'
  | 'signup_submitted'
  | 'registration_completed'
  | 'store_created'
  | 'subscription_paid';

export interface FunnelEvent {
  /** Meta standard event, or the custom name when `metaCustom`. */
  meta: string;
  metaCustom?: boolean;
  posthog: string;
}

export const EBDA_FUNNEL: Record<FunnelStep, FunnelEvent> = {
  page_view: { meta: 'PageView', posthog: '$pageview' },
  pricing_viewed: { meta: 'ViewContent', posthog: 'pricing_viewed' },
  contact_submitted: { meta: 'Lead', posthog: 'contact_submitted' },
  signup_submitted: { meta: 'Lead', posthog: 'signup_submitted' },
  registration_completed: { meta: 'CompleteRegistration', posthog: 'registration_completed' },
  store_created: { meta: 'StoreCreated', metaCustom: true, posthog: 'store_created' },
  subscription_paid: { meta: 'Purchase', posthog: 'subscription_paid' },
};

/** The payload the signup form forwards so the server can attribute the new account. */
export interface SignupTracking {
  attribution?: import('./attribution').EbdaAttribution;
  fbp?: string;
  fbc?: string;
  /** PostHog distinct_id of the ebda instance, so the server-side paid step joins the funnel. */
  phId?: string;
  consent: { analytics: boolean; marketing: boolean };
}
