// @vitest-environment jsdom
/**
 * S2 (2026-10-14): the floating widget's custom button link was the one
 * merchant `<a href>` that reached the page with no scheme check — the API
 * stored `customHref` through `optionalStr`, and FloatingWidget returned it
 * verbatim, so a stored `javascript:` href ran on a visitor's click. Both the
 * dedicated route and the generic `PUT /stores/:id` settings blob could write it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createElement } from 'react';
import { render, cleanup } from '@testing-library/react';
import { readFileSync } from 'fs';
import path from 'path';
import {
  floatingWidgetLinkIssues,
  FLOATING_WIDGET_LINK_KEYS,
} from '../../apps/api/src/lib/floating-widget-links';

const widget = (button: Record<string, unknown>) => ({ floatingWidget: { buttons: [button] } });

describe('floatingWidgetLinkIssues (generic settings write path)', () => {
  it.each(FLOATING_WIDGET_LINK_KEYS)('rejects javascript:/data:/vbscript: in %s', key => {
    for (const bad of [
      'javascript:alert(1)',
      ' JaVaScRiPt:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'java\tscript:alert(1)',
    ]) {
      const issues = floatingWidgetLinkIssues(widget({ id: 'a', kind: 'custom', [key]: bad }));
      expect(issues, `${key}=${JSON.stringify(bad)}`).toHaveLength(1);
      expect(issues[0].path).toEqual(['floatingWidget', 'buttons', 0, key]);
    }
  });

  it.each([
    'https://example.com/x',
    'http://example.com',
    'mailto:a@b.co',
    'tel:+201000000000',
    '/about',
  ])('accepts %s', ok => {
    expect(floatingWidgetLinkIssues(widget({ id: 'a', kind: 'custom', customHref: ok }))).toEqual(
      []
    );
  });

  it('ignores empty values, missing widget, and non-object shapes', () => {
    expect(floatingWidgetLinkIssues(widget({ id: 'a', customHref: '' }))).toEqual([]);
    expect(floatingWidgetLinkIssues(widget({ id: 'a', customHref: '   ' }))).toEqual([]);
    expect(floatingWidgetLinkIssues({})).toEqual([]);
    expect(floatingWidgetLinkIssues(null)).toEqual([]);
    expect(floatingWidgetLinkIssues({ floatingWidget: { buttons: 'nope' } })).toEqual([]);
    expect(floatingWidgetLinkIssues({ floatingWidget: { buttons: [null, 3] } })).toEqual([]);
  });

  it('reports the index of the offending button', () => {
    const issues = floatingWidgetLinkIssues({
      floatingWidget: {
        buttons: [
          { id: 'a', kind: 'custom', customHref: 'https://ok.example' },
          { id: 'b', kind: 'custom', customHref: 'javascript:1' },
        ],
      },
    });
    expect(issues.map(i => i.path)).toEqual([['floatingWidget', 'buttons', 1, 'customHref']]);
  });
});

describe('wiring (static)', () => {
  const read = (p: string) => readFileSync(path.resolve(__dirname, '../..', p), 'utf-8');

  it('the dedicated route validates the three link fields with the safe-URL schema', () => {
    const src = read('apps/api/src/routes/store.routes.ts');
    const block = src.slice(src.indexOf('const floatingButtonSchema'));
    for (const key of FLOATING_WIDGET_LINK_KEYS) {
      expect(block).toMatch(new RegExp(`${key}:\\s*safeOptionalUrl`));
    }
  });

  it('the generic settings schema runs the same check', () => {
    const src = read('apps/api/src/routes/store.routes.ts');
    expect(src).toContain('floatingWidgetLinkIssues(settings)');
  });
});

afterEach(cleanup);

describe('the storefront widget sanitizes the custom href at render', () => {
  const html = async (customHref: string) => {
    const { FloatingWidget } = await import('../../apps/web/src/templates/shared/FloatingWidget');
    const { container } = render(
      createElement(FloatingWidget, {
        isRtl: false,
        theme: undefined,
        config: {
          enabled: true,
          startExpanded: true,
          buttons: [{ id: 'c1', kind: 'custom', customHref }],
        } as never,
      })
    );
    return container.innerHTML;
  };

  it.each(['javascript:alert(1)', ' JaVaScRiPt:alert(1)', 'data:text/html,<b>x</b>'])(
    'never emits %s as an href',
    async bad => {
      const out = await html(bad);
      expect(out).not.toMatch(/href="\s*(javascript|data):/i);
      expect(out.toLowerCase()).not.toContain('javascript:');
    }
  );

  it('keeps a safe https custom link (control)', async () => {
    expect(await html('https://example.com/x')).toContain('href="https://example.com/x"');
  });
});
