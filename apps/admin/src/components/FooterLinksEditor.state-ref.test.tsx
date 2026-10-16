// @vitest-environment jsdom
/**
 * W1c re-review N3: the Page Builder's unsaved-preview bundle reads
 * `stateRef.current.footerLinks`. It carried only the keys the editor edits, so a
 * stored bottom-bar key the editor does not know (and any other stored
 * `footerLinks` key) vanished from the preview. The ref now holds the same
 * merge the save writes (`mergeFooterLinksForSave` over what is stored).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import type { MutableRefObject } from 'react';

const stored = {
  shop: [{ name: 'All', nameAr: 'الكل', href: '/products', enabled: true }],
  newsletterEnabled: false,
  bottomBar: { returnsEnabled: false, legacyKey: 'kept' },
  columnOrder: ['company', 'shop'],
};

vi.mock('@/i18n/useT', () => ({ useT: () => (key: string) => key }));
vi.mock('@ebda/ui', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('../lib/api', () => ({
  apiGet: vi.fn(async () => ({ data: { store: { settings: { footerLinks: stored } } } })),
  apiPut: vi.fn(async () => ({})),
}));

import { FooterLinksEditor, type FooterLinksEditorState } from './FooterLinksEditor';

afterEach(cleanup);

describe('FooterLinksEditor stateRef (preview bundle)', () => {
  it('keeps stored footerLinks keys the editor does not edit, bottom bar included', async () => {
    const ref = { current: null } as MutableRefObject<FooterLinksEditorState | null>;
    render(<FooterLinksEditor storeId="s1" variant="embedded" section="links" stateRef={ref} />);
    await waitFor(() => expect(ref.current?.footerLinks.newsletterEnabled).toBe(false));
    const links = ref.current!.footerLinks as Record<string, unknown> & {
      bottomBar: Record<string, unknown>;
    };
    expect(links.bottomBar).toEqual({ returnsEnabled: false, legacyKey: 'kept' });
    expect(links.columnOrder).toEqual(['company', 'shop']);
    expect(links.shop).toEqual(stored.shop);
  });
});
