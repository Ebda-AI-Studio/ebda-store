// @vitest-environment jsdom
/**
 * Ruling NT1-A-DEFAULT: the WhatsApp column of the notifications matrix is a read-only status derived from the
 * store's Ebda Chat link state, with a link to Ebda Chat. No toggle; an unreadable link state is "unknown", never
 * "not connected".
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('@/i18n/useT', () => ({ useT: () => (k: string) => k }));

import { EventConfigTable } from './EventConfigTable';
import { DEFAULT_EVENTS, type WhatsAppStatus } from './types';

afterEach(cleanup);

function renderTable(whatsapp: WhatsAppStatus) {
  return render(
    <EventConfigTable
      events={DEFAULT_EVENTS}
      smsEnabled
      pushEnabled
      whatsapp={whatsapp}
      saving={false}
      onToggleEventChannel={() => {}}
      onSave={() => {}}
    />
  );
}

const chips = (c: HTMLElement, kind: string) =>
  Array.from(c.querySelectorAll(`[data-whatsapp-status="${kind}"]`));

describe('notifications matrix, WhatsApp column', () => {
  it('linked store: Chat-sent events say sent by Chat and link to Ebda Chat; others say not sent', () => {
    const { container } = renderTable({ kind: 'ready', active: true });
    expect(chips(container, 'sent').length).toBeGreaterThanOrEqual(4);
    expect(chips(container, 'none').length).toBe(3);
    expect(chips(container, 'not-connected')).toHaveLength(0);
    const links = Array.from(container.querySelectorAll('a')).map(a => a.getAttribute('href'));
    expect(links.length).toBeGreaterThan(0);
    expect(links.every(h => h === 'https://wa.ebda.app')).toBe(true);
    expect(screen.getAllByText('whatsapp.explainer').length).toBeGreaterThan(0);
  });

  it('unlinked store: not connected plus a connect link', () => {
    const { container } = renderTable({ kind: 'ready', active: false });
    expect(chips(container, 'not-connected').length).toBeGreaterThanOrEqual(4);
    expect(chips(container, 'sent')).toHaveLength(0);
    expect(screen.getAllByText('connect').length).toBeGreaterThan(0);
  });

  it('link-state failure renders unknown, not "not connected"', () => {
    const { container } = renderTable({ kind: 'error' });
    expect(chips(container, 'unknown').length).toBe(DEFAULT_EVENTS.length);
    expect(chips(container, 'not-connected')).toHaveLength(0);
    expect(chips(container, 'sent')).toHaveLength(0);
  });

  it('the WhatsApp column has no toggle control', () => {
    const { container } = renderTable({ kind: 'ready', active: true });
    for (const cell of Array.from(container.querySelectorAll('[data-whatsapp-status]'))) {
      const host = cell.parentElement as HTMLElement;
      expect(host.querySelector('input, button, [role="switch"], [role="checkbox"]')).toBeNull();
    }
    // sms + push checkboxes remain: 7 events x 2 channels (the table may render a mobile and a desktop layout)
    expect(container.querySelectorAll('input[type="checkbox"]').length % 14).toBe(0);
  });
});

describe('notifications copy', () => {
  const read = (l: string) =>
    JSON.parse(
      readFileSync(join(process.cwd(), 'apps/admin/src/i18n/messages', `${l}.json`), 'utf8')
    ) as { notifications: unknown };
  for (const locale of ['ar', 'en']) {
    it(`${locale}: no VAPID / W3C jargon in the notifications strings`, () => {
      expect(JSON.stringify(read(locale).notifications)).not.toMatch(/VAPID|W3C/);
    });
  }
  it('ar: the events subtitle no longer uses the stiff "تُشغّل" phrasing', () => {
    expect(JSON.stringify(read('ar').notifications)).not.toContain('تُشغّل');
  });
});
