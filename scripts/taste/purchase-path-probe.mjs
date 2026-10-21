// Quality bar § 10 rules (d) and contrast, measured on the RENDERED purchase path (W5).
//
// The W4 rule (d) gate read Tailwind classes in jsdom; it passed while seven cart and checkout
// controls measured 16-32px in the browser (independent a11y re-audit, 2026-10-16). This probe
// runs inside each real page that scripts/taste/shoot-purchase-path.mjs visits:
//   - targets: every visible, enabled interactive element's hit box (its border box grown by an
//     absolutely positioned ::before inset, the platform's hit-area idiom) must be >= 44x44;
//   - contrast: on screens that ask for it, every visible text run must reach 4.5:1 (3:1 at
//     >= 24px, or >= 18.66px bold) against its composited background.
// The math lives in plain functions so tests/unit/purchase-path-probe.test.ts can pin it.

export const MIN_TARGET = 44;

/** Hit box: the border box grown by a ::before that is absolutely positioned with negative insets. */
export function hitBox(rect, before) {
  const grow = v => (typeof v === 'number' && v < 0 ? -v : 0);
  if (!before || before.position !== 'absolute') return { w: rect.width, h: rect.height };
  return {
    w: rect.width + grow(before.left) + grow(before.right),
    h: rect.height + grow(before.top) + grow(before.bottom),
  };
}

/** "rgb(1, 2, 3)" / "rgba(1, 2, 3, 0.5)" / "color(srgb 0.1 0.2 0.3 / 0.5)" to {r,g,b,a} (0-255, 0-1). */
export function parseCssColor(s) {
  if (!s) return null;
  let m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(s);
  if (m) {
    const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : +m[4];
    return { r: +m[1], g: +m[2], b: +m[3], a };
  }
  m = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)$/.exec(s);
  if (m) return { r: m[1] * 255, g: m[2] * 255, b: m[3] * 255, a: m[4] === undefined ? 1 : +m[4] };
  return null;
}

/** `fg` (with its alpha) painted over the opaque `bg`. */
export function composite(fg, bg) {
  const a = fg.a ?? 1;
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
    a: 1,
  };
}

export function luminance({ r, g, b }) {
  const ch = v => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** WCAG 1.4.3: large text is >= 24px, or >= 18.66px at weight >= 700. */
export function minContrastFor(fontPx, weight) {
  return fontPx >= 24 || (fontPx >= 18.66 && weight >= 700) ? 3 : 4.5;
}

/** Installs the probe in the page (the functions above, serialised) and runs it. */
export async function probePage(page, { contrast: wantContrast = false } = {}) {
  const lib = [hitBox, parseCssColor, composite, luminance, contrast, minContrastFor]
    .map(f => f.toString())
    .join('\n');
  return page.evaluate(
    ({ lib, MIN, wantContrast }) => {
      // eslint-disable-next-line no-new-func
      const L = new Function(
        `${lib}; return { hitBox, parseCssColor, composite, luminance, contrast, minContrastFor };`
      )();
      const visible = el => {
        if (el.closest('[aria-hidden="true"], [inert], dialog:not([open])')) return false;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none') return false;
        const r = el.getBoundingClientRect();
        // A visually hidden skip link (sr-only, 1x1 until focused) is measured when it shows.
        return r.width > 1 && r.height > 1;
      };
      const px = v => (v.endsWith('px') ? parseFloat(v) : undefined);
      const label = el =>
        `${el.tagName.toLowerCase()} "${(el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || '').trim().replace(/\s+/g, ' ').slice(0, 40)}"`;

      const targets = [];
      const sel =
        'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="combobox"], [role="tab"]';
      for (const el of document.querySelectorAll(sel)) {
        if (!visible(el) || el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
        // A native radio/checkbox is operated through its label: measure the label.
        let target = el;
        if (/^(radio|checkbox)$/.test(el.type) && el.closest('label')) target = el.closest('label');
        const r = target.getBoundingClientRect();
        const b = getComputedStyle(target, '::before');
        const box = L.hitBox(r, {
          position: b.content && b.content !== 'none' ? b.position : 'static',
          top: px(b.top),
          right: px(b.right),
          bottom: px(b.bottom),
          left: px(b.left),
        });
        if (box.w < MIN - 0.5 || box.h < MIN - 0.5)
          targets.push(`${label(el)} ${Math.round(box.w)}x${Math.round(box.h)}`);
      }

      const lowContrast = [];
      if (wantContrast) {
        const bgOf = el => {
          // Composite the background layers from the page down to this element.
          const chain = [];
          for (let n = el; n && n.nodeType === 1; n = n.parentElement) chain.unshift(n);
          let bg = { r: 255, g: 255, b: 255, a: 1 };
          let photo = false;
          for (const n of chain) {
            const cs = getComputedStyle(n);
            if (cs.backgroundImage && cs.backgroundImage !== 'none') photo = true;
            const c = L.parseCssColor(cs.backgroundColor);
            if (c && c.a > 0) bg = L.composite({ ...c, a: c.a * Number(cs.opacity) }, bg);
          }
          return { bg, photo };
        };
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        const seen = new Set();
        for (let t = walker.nextNode(); t; t = walker.nextNode()) {
          const el = t.parentElement;
          if (!el || seen.has(el) || !t.textContent.trim() || !visible(el)) continue;
          if (el.closest('script, style, noscript, svg')) continue;
          seen.add(el);
          const cs = getComputedStyle(el);
          const fg = L.parseCssColor(cs.color);
          if (!fg) continue;
          let alpha = fg.a;
          for (let n = el; n && n.nodeType === 1; n = n.parentElement)
            alpha *= Number(getComputedStyle(n).opacity);
          const { bg, photo } = bgOf(el);
          if (photo) continue; // text on a photo is the scrim rule's job, not this probe's
          const ratio = L.contrast(L.composite({ ...fg, a: alpha }, bg), bg);
          const need = L.minContrastFor(parseFloat(cs.fontSize), Number(cs.fontWeight));
          if (ratio < need) lowContrast.push(`${label(el)} ${ratio.toFixed(2)}:1 < ${need}`);
        }
      }
      return { targets, lowContrast };
    },
    { lib, MIN: MIN_TARGET, wantContrast }
  );
}
