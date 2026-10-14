import { isSafeUrl } from '@force/shared';

/**
 * Floating-widget button fields that become an `<a href>` on the storefront.
 * `customHref` is the one rendered verbatim; the YouTube/Facebook URLs are only
 * http(s)-checked at render. All three are scheme-validated at save (S2): the
 * dedicated `/floating-widget` route validates them in its Zod schema, and the
 * generic `PUT /stores/:id` `settings` blob (an open `z.record`) goes through
 * {@link floatingWidgetLinkIssues}, so neither write path can persist
 * `javascript:` / `data:` / `vbscript:`. The storefront sanitizes again at
 * render for rows saved before this existed.
 */
export const FLOATING_WIDGET_LINK_KEYS = ['customHref', 'youtubeUrl', 'facebookUrl'] as const;

export interface LinkIssue {
  path: (string | number)[];
  message: string;
}

export function floatingWidgetLinkIssues(settings: unknown): LinkIssue[] {
  if (!settings || typeof settings !== 'object') return [];
  const widget = (settings as Record<string, unknown>).floatingWidget;
  if (!widget || typeof widget !== 'object') return [];
  const buttons = (widget as Record<string, unknown>).buttons;
  if (!Array.isArray(buttons)) return [];
  const issues: LinkIssue[] = [];
  buttons.forEach((button, index) => {
    if (!button || typeof button !== 'object') return;
    for (const key of FLOATING_WIDGET_LINK_KEYS) {
      const value = (button as Record<string, unknown>)[key];
      if (typeof value === 'string' && value.trim() !== '' && !isSafeUrl(value)) {
        issues.push({
          path: ['floatingWidget', 'buttons', index, key],
          message:
            'Link must be a relative path or use http(s)/mailto/tel — javascript: is not allowed',
        });
      }
    }
  });
  return issues;
}
