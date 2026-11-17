/**
 * Editor bug 3: pure helpers behind the header/footer draft (`chrome`) and the
 * classic-save re-base. The service-level behaviour is pinned in
 * page-builder-chrome-draft.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  applyChromePatch,
  chromeLogoColumns,
  chromePreviewSettings,
  draftChromeSchema,
  layoutToDefinition,
  pageDefinitionSchema,
  rebaseDraftOntoLive,
  resolveLayoutSettings,
  type PageDefinition,
} from '@ebda/shared';

const BASE = layoutToDefinition(resolveLayoutSettings({}, 'qamar'), 'home');

describe('draftChromeSchema', () => {
  it.each(['/products', '#top', 'https://example.com/a', 'mailto:a@b.co', 'tel:+201000000000', ''])(
    'accepts the link %j',
    href => {
      expect(draftChromeSchema.safeParse({ navMenu: [{ label: 'a', href }] }).success).toBe(true);
    }
  );

  it.each([
    'javascript:alert(1)',
    ' JAVASCRIPT:alert(1)',
    'data:text/html,x',
    'vbscript:x',
    'file:///etc/passwd',
    'java\tscript:alert(1)',
    'example.com/no-scheme',
  ])('rejects the link %j in the menu, footer columns and utility bar', href => {
    expect(draftChromeSchema.safeParse({ navMenu: [{ label: 'a', href }] }).success).toBe(false);
    expect(
      draftChromeSchema.safeParse({ footerLinks: { shop: [{ name: 'a', href }] } }).success
    ).toBe(false);
    expect(
      draftChromeSchema.safeParse({ utilityBar: { links: [{ label: 'a', href }] } }).success
    ).toBe(false);
  });

  it('is strict: unknown keys and over-long lists are rejected', () => {
    expect(draftChromeSchema.safeParse({ favicon: 'https://x/y.png' }).success).toBe(false);
    expect(
      draftChromeSchema.safeParse({ navMenu: [{ label: 'a', href: '/', onclick: 'x' }] }).success
    ).toBe(false);
    const many = Array.from({ length: 13 }, () => ({ label: 'a', href: '/' }));
    expect(draftChromeSchema.safeParse({ navMenu: many }).success).toBe(false);
  });

  it('is part of the page document schema', () => {
    const ok = pageDefinitionSchema.safeParse({
      ...BASE,
      chrome: { navMenu: [{ label: 'a', href: '/' }] },
    });
    expect(ok.success).toBe(true);
    const bad = pageDefinitionSchema.safeParse({
      ...BASE,
      chrome: { navMenu: [{ label: 'a', href: 'javascript:1' }] },
    });
    expect(bad.success).toBe(false);
  });
});

describe('applyChromePatch', () => {
  const live = {
    contact: { phone: '1' },
    navMenu: [{ label: 'Old', href: '/old' }],
    footerLinks: {
      shop: [{ name: 's', href: '/s', enabled: true }],
      support: [{ name: 'h', href: '/h', enabled: true }],
      bottomBar: { enabled: false },
    },
    utilityBar: { enabled: true, links: [{ label: 'c', href: '/c', enabled: true }] },
  };

  it('replaces only the keys the patch carries and never mutates the live object', () => {
    const snapshot = JSON.stringify(live);
    const out = applyChromePatch(live, {
      footerLinks: { company: [{ name: 'About', href: '/about' }] },
    });
    expect(out.navMenu).toEqual(live.navMenu);
    expect(out.contact).toEqual({ phone: '1' });
    expect((out.footerLinks as any).shop).toEqual(live.footerLinks.shop);
    expect((out.footerLinks as any).bottomBar).toEqual({ enabled: false });
    expect((out.footerLinks as any).company).toEqual([
      { name: 'About', href: '/about', enabled: true },
    ]);
    expect(JSON.stringify(live)).toBe(snapshot);
  });

  it('drops blank and unsafe rows and ignores an all-blank menu (the classic editor refuses it)', () => {
    const out = applyChromePatch(live, {
      navMenu: [
        { label: ' Shop ', href: ' /products ' },
        { label: '', href: '/x' },
        { label: 'y', href: '' },
      ],
    });
    expect(out.navMenu).toEqual([{ label: 'Shop', href: '/products' }]);
    expect(applyChromePatch(live, { navMenu: [{ label: '', href: '' }] }).navMenu).toEqual(
      live.navMenu
    );
  });

  it('merges utilityBar flags and links independently', () => {
    const off = applyChromePatch(live, { utilityBar: { enabled: false } });
    expect(off.utilityBar).toEqual({ enabled: false, links: live.utilityBar.links });
  });

  it('works on a store with no settings at all', () => {
    expect(applyChromePatch(null, { navMenu: [{ label: 'a', href: '/' }] })).toEqual({
      navMenu: [{ label: 'a', href: '/' }],
    });
  });

  it('preview settings carry only the patched keys (what the canvas should override)', () => {
    expect(chromePreviewSettings(live, undefined)).toBeNull();
    expect(chromePreviewSettings(live, {})).toBeNull();
    expect(
      Object.keys(chromePreviewSettings(live, { navMenu: [{ label: 'a', href: '/' }] })!)
    ).toEqual(['navMenu']);
  });
});

describe('rebaseDraftOntoLive (classic save vs pending visual draft)', () => {
  const edit = (
    doc: PageDefinition,
    id: string,
    patch: Record<string, unknown>
  ): PageDefinition => ({
    ...doc,
    sections: doc.sections.map(s =>
      s.id === id ? { ...s, settings: { ...s.settings, ...patch } } : s
    ),
  });

  it('applies only what the classic save changed and keeps the other edits of the SAME section', () => {
    const draft = edit(BASE, 'categories', {
      title: 'Draft title',
    });
    const next = edit(BASE, 'categories', { columns: 5 });
    const out = rebaseDraftOntoLive(draft, BASE, next);
    const cat = out.sections.find(s => s.id === 'categories')!;
    expect(cat.settings.title).toBe('Draft title'); // visual edit kept
    expect(cat.settings.columns).toBe(5); // classic edit applied
  });

  it('classic wins on the exact field it changed', () => {
    const draft = edit(BASE, 'categories', { title: 'Draft' });
    const next = edit(BASE, 'categories', { title: 'Classic' });
    const out = rebaseDraftOntoLive(draft, BASE, next);
    expect(out.sections.find(s => s.id === 'categories')!.settings.title).toBe('Classic');
  });

  it('keeps draft-only sections, theme and chrome; adds a header the classic save created', () => {
    const draft: PageDefinition = {
      ...BASE,
      sections: [...BASE.sections, { id: 'image-text-1', type: 'image-text', settings: {} }],
      theme: { primaryColor: '1 1% 1%' },
      chrome: { navMenu: [{ label: 'a', href: '/' }] },
    };
    const next = layoutToDefinition(
      resolveLayoutSettings({ header: { sticky: true } }, 'qamar'),
      'home'
    );
    const out = rebaseDraftOntoLive(draft, BASE, next);
    expect(out.sections.some(s => s.id === 'image-text-1')).toBe(true);
    expect(out.theme).toEqual({ primaryColor: '1 1% 1%' });
    expect(out.chrome).toEqual({ navMenu: [{ label: 'a', href: '/' }] });
    expect(out.sectionGroups.header.map(s => s.type)).toEqual(['header']);
  });

  it('a section the draft deleted stays deleted when the classic save edits it', () => {
    const draft: PageDefinition = {
      ...BASE,
      sections: BASE.sections.filter(s => s.id !== 'categories'),
    };
    const next = edit(BASE, 'categories', { columns: 5 });
    const out = rebaseDraftOntoLive(draft, BASE, next);
    expect(out.sections.some(s => s.id === 'categories')).toBe(false);
  });

  it('an unchanged classic save changes nothing', () => {
    const draft = edit(BASE, 'categories', { title: 'Draft' });
    expect(rebaseDraftOntoLive(draft, BASE, BASE)).toEqual(draft);
  });

  it('applies a classic reorder to the shared sections, keeping draft-only ones', () => {
    const reordered: PageDefinition = { ...BASE, sections: [...BASE.sections].reverse() };
    const draft: PageDefinition = {
      ...BASE,
      sections: [...BASE.sections, { id: 'image-text-1', type: 'image-text', settings: {} }],
    };
    const out = rebaseDraftOntoLive(draft, BASE, reordered);
    expect(out.sections.map(s => s.id).slice(0, BASE.sections.length)).toEqual(
      reordered.sections.map(s => s.id)
    );
    expect(out.sections.at(-1)!.id).toBe('image-text-1');
  });

  it('output is a valid page document', () => {
    const draft = edit(BASE, 'categories', { title: 'Draft' });
    const next = edit(BASE, 'categories', { columns: 5 });
    expect(pageDefinitionSchema.safeParse(rebaseDraftOntoLive(draft, BASE, next)).success).toBe(
      true
    );
  });
});

describe('draft logo (chrome.logo / chrome.logoAr)', () => {
  it.each(['/media/logo.png', 'https://media.ebda.app/a.png', ''])('accepts %j', logo => {
    expect(draftChromeSchema.safeParse({ logo, logoAr: logo }).success).toBe(true);
  });
  it.each([
    'javascript:alert(1)',
    'data:image/png;base64,AAAA',
    'mailto:a@b.co',
    'tel:+20100',
    'logo.png',
    'x'.repeat(501),
  ])('rejects %j', logo => {
    expect(draftChromeSchema.safeParse({ logo }).success).toBe(false);
    expect(draftChromeSchema.safeParse({ logoAr: logo }).success).toBe(false);
  });
  it('chromeLogoColumns returns only non-blank safe keys; applyChromePatch never touches settings for it', () => {
    expect(chromeLogoColumns({ logo: ' https://m.ebda.app/a.png ', logoAr: '' })).toEqual({
      logo: 'https://m.ebda.app/a.png',
    });
    expect(chromeLogoColumns(undefined)).toEqual({});
    expect(applyChromePatch({ a: 1 }, { logo: 'https://m.ebda.app/a.png' })).toEqual({ a: 1 });
  });
});
