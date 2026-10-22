/**
 * Task 10 (EP Task 5): the admin reads top to bottom like the storefront. `flowOrder` is the
 * section types of a store's home in the order the storefront draws them, and the add-section
 * picker follows it.
 */
import { describe, it, expect } from 'vitest';
import {
  LOOKS,
  TEMPLATE_FAMILIES,
  applyTemplateFamily,
  getSectionDefinition,
  layoutToDefinition,
  resolveLayoutSettings,
} from '@ebda/shared';
import { flowOrder, orderByFlow } from '../../apps/admin/src/lib/builder-flow-order';

const unique = (xs: string[]) => [...new Set(xs)];

describe('flowOrder', () => {
  for (const look of LOOKS.filter(l => l.status === 'built')) {
    it(`${look.id}: the order a look switch lays the home out in`, () => {
      const base = layoutToDefinition(resolveLayoutSettings({}, look.skin));
      const doc = applyTemplateFamily(base, look.template as never, look);
      expect(flowOrder(look.skin, look.id)).toEqual(
        unique(
          doc.sections.map(n => n.type).filter(t => getSectionDefinition(t)?.group === 'template')
        )
      );
    });
  }

  it('a store with no look follows the skin default layout', () => {
    for (const skin of ['modern', 'minimal', 'qamar'] as const) {
      const doc = layoutToDefinition(resolveLayoutSettings({}, skin));
      expect(flowOrder(skin, null)).toEqual(unique(doc.sections.map(n => n.type)));
    }
  });

  it('an unknown look or template never throws and falls back to a layout', () => {
    expect(flowOrder('from-the-future', 'nope.nothing').length).toBeGreaterThan(0);
    expect(flowOrder(undefined, undefined).length).toBeGreaterThan(0);
  });

  it('the picker lists the store’s own types first, in storefront order, the rest after', () => {
    const own = flowOrder('qamar', 'qamar.atelier');
    const all = ['newsletter', ...own.slice().reverse(), 'steps'];
    const { first, more } = orderByFlow(all, own);
    expect(first).toEqual(own);
    expect(more).toEqual(['newsletter', 'steps']);
  });

  it('covers every template family', () => {
    for (const f of TEMPLATE_FAMILIES) expect(flowOrder(f.id, null).length).toBeGreaterThan(0);
  });
});
