/**
 * API error codes the campaign editor translates (`campaigns.errors.<key>`).
 * Any other code falls back to the API's raw English `error.message`, so every
 * 4xx code campaign.routes.ts can return to this editor belongs here —
 * pinned by campaignErrorKeys.test.ts, which reads the route's own throws.
 */
export const CAMPAIGN_ERROR_KEYS: Record<string, string> = {
  DAILY_CAP_EXCEEDED: 'dailyCapExceeded',
  EMPTY_AUDIENCE: 'emptyAudience',
  CAMPAIGN_INCOMPLETE: 'campaignIncomplete',
  INVALID_SCHEDULE: 'invalidSchedule',
  CAMPAIGN_QUEUE_UNREACHABLE: 'queueUnreachable',
  FEATURE_DISABLED: 'featureDisabled',
  CAMPAIGN_NOT_DRAFT: 'notDraft',
  CAMPAIGN_NOT_EDITABLE: 'notEditable',
  // Still reachable on a race (the campaign flipped to `sending`, or mailed,
  // between page load and click) even though the button is hidden (#2082).
  CAMPAIGN_NOT_DELETABLE: 'notDeletable',
  CAMPAIGN_HAS_SEND_HISTORY: 'hasSendHistory',
  CAMPAIGN_NOT_CANCELLABLE: 'notCancellable',
  NO_ADMIN_EMAIL: 'noAdminEmail',
};
