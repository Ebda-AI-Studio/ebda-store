import type { LookTemplate } from '@ebda/shared';

/**
 * The ONE map from a template to its demo store's host label (Ruling B2-7): each template has its
 * own `is_demo` store, so the Qamar catalogue never appears on the Souq demo or the reverse. The
 * label is the first DNS label of the store host (`storedemo.ebda.app`, `storedemo-souq.ebda.app`, `storedemo-jasmine.ebda.app`, `storedemo-lamma.ebda.app`, `storedemo-dahab.ebda.app`);
 * the apex comes from the host the visitor is on, so previews and staging work unchanged.
 * Only `is_demo` guards decide what a demo store may do; nothing branches on these labels.
 */
export const DEMO_HOSTS: Partial<Record<LookTemplate, string>> = {
  qamar: 'storedemo',
  souq: 'storedemo-souq',
  jasmine: 'storedemo-jasmine',
  lamma: 'storedemo-lamma',
  dahab: 'storedemo-dahab',
};

/** Templates that have a demo host (the bar lists only these, and only with a built look). */
export const demoTemplates = (): LookTemplate[] => Object.keys(DEMO_HOSTS) as LookTemplate[];

/**
 * The host of `template`'s demo store, built from `currentHost` (`storedemo.ebda.app:3000` ->
 * `storedemo-souq.ebda.app:3000`). null when the visitor is not on a demo host (a local look store,
 * localhost, an unknown host) or the template has no demo store: the caller then stays put.
 */
export function demoHostFor(template: LookTemplate, currentHost: string): string | null {
  const label = DEMO_HOSTS[template];
  if (!label || !currentHost) return null;
  const [first, ...rest] = currentHost.split('.');
  if (!Object.values(DEMO_HOSTS).includes(first) || rest.length === 0) return null;
  return [label, ...rest].join('.');
}
