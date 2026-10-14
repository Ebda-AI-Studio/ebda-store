import { LOOK_FONTS } from './looks-fonts';

const SPLIT = '<!--look-->';

/** One template's fragment: shared CSS plus one markup block per look. */
export type Frag = { css: string; looks: string[] };

/** /looks/<id> (public/looks/<id>.html) is `<style>` + one block per look, separated by <!--look-->. */
export function parseFragment(html: string): Frag {
  const [css, ...looks] = html.split(SPLIT);
  return { css: css.replace(/^<style>|<\/style>$/g, ''), looks };
}

function fontHref(id: string): string | null {
  const fams = LOOK_FONTS[id as keyof typeof LOOK_FONTS];
  return fams
    ? `https://fonts.googleapis.com/css2?${fams.map(f => `family=${f}`).join('&')}&display=swap`
    : null;
}

/** Adds the template's Google Fonts stylesheet once per page (client only). */
export function ensureLookFont(id: string): void {
  const href = fontHref(id);
  if (!href || document.querySelector(`link[data-looks-font="${id}"]`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.dataset.looksFont = id;
  document.head.appendChild(link);
}
