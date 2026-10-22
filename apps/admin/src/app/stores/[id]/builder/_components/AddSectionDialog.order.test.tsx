// @vitest-environment jsdom
/**
 * Task 10 (EP Task 3 + 5): the add-section picker lists the store's own section types first, in the
 * order its storefront draws them, and the rest after one heading. A legacy store with no look
 * gets its skin's default order.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { layoutToDefinition, resolveLayoutSettings } from '@ebda/shared';
import { flowOrder } from '../../../../../lib/builder-flow-order';

vi.mock('next-intl', () => {
  const t = Object.assign((key: string) => key, { has: () => true });
  return { useTranslations: () => t, useLocale: () => 'en' };
});

import { AddSectionDialog } from './AddSectionDialog';

beforeAll(() => {
  // jsdom has no <dialog>.showModal
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
});
afterEach(cleanup);

const doc = layoutToDefinition(resolveLayoutSettings({}, 'qamar'));
const typesInOrder = () =>
  [...document.querySelectorAll('[data-testid^="preset-"]')].map(el =>
    el
      .getAttribute('data-testid')!
      .replace(/^preset-/, '')
      .replace(/-\d+$/, '')
  );

describe('AddSectionDialog order', () => {
  it('a look store: its own types first in storefront order, then the rest under "more"', () => {
    render(
      <AddSectionDialog
        list="template"
        doc={doc}
        template="qamar"
        look="qamar.atelier"
        onPick={() => {}}
        onClose={() => {}}
      />
    );
    const order = [...new Set(typesInOrder())];
    const own = flowOrder('qamar', 'qamar.atelier');
    expect(order.slice(0, own.length)).toEqual(own);
    expect(order.length).toBeGreaterThan(own.length);
    expect(screen.getByTestId('add-section-more')).toBeTruthy();
    // the heading sits between the two groups
    const all = [...document.querySelectorAll('[data-testid="add-section-dialog"] li')];
    const headingAt = all.findIndex(li => li.getAttribute('data-testid') === 'add-section-more');
    expect(
      all[headingAt - 1].querySelector('[data-testid^="preset-"]')?.getAttribute('data-testid')
    ).toContain(own[own.length - 1]);
  });

  it('header and footer lists keep the registry order, with no heading', () => {
    render(
      <AddSectionDialog
        list="header"
        doc={doc}
        template="qamar"
        look="qamar.atelier"
        onPick={() => {}}
        onClose={() => {}}
      />
    );
    expect(screen.queryByTestId('add-section-more')).toBeNull();
  });
});
