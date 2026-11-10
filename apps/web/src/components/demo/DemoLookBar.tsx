'use client';

import { useEffect } from 'react';
import { LOOKS, type LookTemplate } from '@ebda/shared';
import { usePathname, useSearchParams } from 'next/navigation';
import { useLanguage, translations } from '../../contexts/LanguageContext';
import { defaultIsLookBuilt, type IsLookBuilt } from '../../lib/demo-look';
import { DEMO_HOSTS, demoHostFor } from '../../lib/demo-hosts';

/** Template display names (the five looks families). */
const TEMPLATE_NAMES: Record<LookTemplate, { en: string; ar: string }> = {
  qamar: { en: 'Qamar', ar: 'قمر' },
  souq: { en: 'Souq', ar: 'سوق' },
  jasmine: { en: 'Jasmine', ar: 'ياسمين' },
  lamma: { en: 'Lamma', ar: 'لمّة' },
  dahab: { en: 'Dahab', ar: 'دهب' },
};

/**
 * The bar is the INVERSE surface (page colour on ink), so the select boundary is the page colour
 * at 70%: >= 3:1 against the bar on every look (WCAG 1.4.11, pinned by DemoLookBar.test). The
 * `--input` token is tuned for fields on the page, not on ink, and measured 1.57-2.76:1 here.
 */
export const DEMO_BAR_SELECT_CLASS =
  // The native chevron sat over the text of a narrow RTL select ("لوك بوك" hidden under it). The arrow is drawn as a background at the
  // INLINE END instead (right in English, left in Arabic via rtl:) and `pe-8` reserves its room, so the text never reaches it at any width.
  'min-h-11 appearance-none rounded border border-background/70 bg-foreground bg-no-repeat ps-2 pe-8 text-base text-background sm:text-sm [background-image:linear-gradient(45deg,transparent_50%,currentColor_50%),linear-gradient(135deg,currentColor_50%,transparent_50%)] [background-position:calc(100%-17px)_50%,calc(100%-12px)_50%] [background-size:5px_5px,5px_5px] rtl:[background-position:12px_50%,17px_50%] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-background';

/**
 * Showroom bar for the demo store (`store.isDemo`): template, then one of its BUILT looks
 * (Ruling B1-12, MKT-3 wording). A template with no built look is not listed, and with no built
 * look at all the bar renders nothing. `isBuilt` is injectable for tests (default: the
 * registry's `status === 'built'`).
 *
 * Choosing loads `?look=<id>` on the same path (full document load; other query params kept); the
 * server applies it through the normal composition path (`lib/demo-look.ts`). Nothing is ever
 * written: the preview lives in the URL only (LOOKS-12 forbids a cookie). While a preview is
 * showing, a same-origin link click carries `look=<id>` to the next page (Ruling B1-11), so a
 * product opened from a Lookbook preview renders Lookbook too. Programmatic navigations
 * (`router.push`, e.g. cart → checkout) still drop it; checkout is refused on the demo anyway.
 */
export function DemoLookBar({
  activeLook,
  isBuilt = defaultIsLookBuilt,
}: {
  activeLook?: string | null;
  isBuilt?: IsLookBuilt;
}) {
  const { language, t } = useLanguage();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const lang = language === 'ar' ? 'ar' : 'en';

  // The look this page is previewing: the URL asked for it AND the server applied it (a look
  // that is not built is ignored server-side, so `activeLook` is then the store's own look).
  const previewLook =
    activeLook && searchParams?.get('look') === activeLook && isBuilt(activeLook)
      ? activeLook
      : null;

  useEffect(() => {
    if (!previewLook) return;
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
        return;
      const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!a || (a.target && a.target !== '_self') || a.hasAttribute('download')) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin || url.searchParams.get('look') === previewLook)
        return;
      url.searchParams.set('look', previewLook);
      e.preventDefault();
      // Full document load: the look is applied in the root layout (data-look, CSS vars, fonts).
      window.location.assign(url.pathname + url.search + url.hash);
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [previewLook]);

  const built = LOOKS.filter(l => isBuilt(l.id));

  // Warm the sibling looks of THIS template (read-only GETs of this very page with `?look=`),
  // once the page is idle: the switch is a full document load whose cost is the cold server render
  // and its API reads, so the visitor's click lands on warm caches. Demo bar only (it renders for
  // `store.isDemo` alone); nothing is written and no merchant store is touched.
  const warmKey = built.map(l => l.id).join(',');
  useEffect(() => {
    if (typeof window === 'undefined' || typeof fetch !== 'function') return;
    const cur = built.find(l => l.id === activeLook);
    if (!cur) return;
    const targets = built.filter(l => l.template === cur.template && l.id !== cur.id);
    const run = () => {
      for (const l of targets) {
        const params = new URLSearchParams(window.location.search);
        params.set('look', l.id);
        fetch(`${window.location.pathname}?${params.toString()}`, {
          credentials: 'same-origin',
          priority: 'low',
        } as RequestInit)
          // Drain the body: a page over the browser's fetch buffer (the image-rich Dahab homes are
          // 150-180 KB) otherwise stays "pending" forever, which holds the connection and keeps
          // the page from ever going network-idle.
          .then(r => r?.arrayBuffer?.())
          .catch(() => {});
      }
    };
    const w = window as Window & { requestIdleCallback?: (cb: () => void) => number };
    const id = w.requestIdleCallback ? w.requestIdleCallback(run) : window.setTimeout(run, 1500);
    return () => {
      if (!w.requestIdleCallback) window.clearTimeout(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeLook, warmKey]);

  if (built.length === 0) return null;

  // Only a template with a built look AND a demo store of its own is offered (Ruling B2-7).
  const templates = [...new Set(built.map(l => l.template))].filter(tpl => tpl in DEMO_HOSTS);
  const current = built.find(l => l.id === activeLook);
  const activeTemplate = current?.template ?? templates[0];
  const looks = built.filter(l => l.template === activeTemplate);

  const go = (lookId: string) => {
    const params = new URLSearchParams(searchParams?.toString() ?? '');
    params.set('look', lookId);
    // Full document load, not router.push: a search-param-only App Router navigation re-renders
    // the page segment but NOT the root layout, which is where the look's data-look, CSS vars,
    // font link and StoreProvider initialStore are applied.
    window.location.assign(`${pathname}?${params.toString()}`);
  };

  // Choosing another template leaves this store for that template's demo store (its own catalogue,
  // never a filter over this one), keeping `?look=` of the template's first built look. When the
  // visitor is not on a demo host (a local look store), the look is applied on the same host.
  const goTemplate = (tpl: LookTemplate) => {
    const first = built.find(l => l.template === tpl);
    if (!first) return;
    const host = demoHostFor(tpl, window.location.host ?? '');
    if (host && host !== window.location.host) {
      window.location.assign(`${window.location.protocol}//${host}/?look=${first.id}`);
      return;
    }
    go(first.id);
  };

  const label = 'flex items-center gap-2';
  // Labels are visible from sm up; on a phone the two selects carry them as accessible names.
  const labelText = 'sr-only sm:not-sr-only';

  return (
    <div
      data-demo-look-bar
      role="region"
      aria-label={t('Demo store', translations['Demo store'])}
      className="border-b border-background/20 bg-foreground text-background"
    >
      <div className="mx-auto flex max-w-screen-xl flex-wrap items-center justify-center gap-x-3 gap-y-1 px-4 py-1 text-xs sm:text-sm">
        <span className="font-medium">{t('Demo store', translations['Demo store'])}</span>
        <label className={label}>
          <span className={labelText}>{t('Template', translations['Template'])}</span>
          <select
            data-demo-template
            className={DEMO_BAR_SELECT_CLASS}
            value={activeTemplate}
            onChange={e => goTemplate(e.target.value as LookTemplate)}
          >
            {templates.map(tpl => (
              <option key={tpl} value={tpl}>
                {TEMPLATE_NAMES[tpl][lang]}
              </option>
            ))}
          </select>
        </label>
        <label className={label}>
          <span className={labelText}>{t('Look', translations['Look'])}</span>
          <select
            data-demo-look
            className={DEMO_BAR_SELECT_CLASS}
            value={current ? current.id : ''}
            onChange={e => go(e.target.value)}
          >
            {current ? null : (
              <option value="" disabled>
                {t('Choose a look', translations['Choose a look'])}
              </option>
            )}
            {looks.map(l => (
              <option key={l.id} value={l.id}>
                {l.name[lang]}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}
