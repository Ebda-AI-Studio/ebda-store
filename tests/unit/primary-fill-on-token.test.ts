/**
 * K-02 (Qamar taste audit 2026-10-15, quality-bar § 3): a fill is always paired
 * with its on-token. `bg-primary text-white` sat on 33+ storefront elements; on a
 * light primary (Lookbook) white measures 2.16:1. `--primary-foreground` is the
 * store's own on-primary ink, so `bg-primary` ⇒ `text-primary-foreground`.
 *
 * One element = one `className` expression (every string literal inside it,
 * ternary arms and cn() arguments included) or one CSS `@apply`. Within it, the
 * same variant prefix (`''`, `hover:`, `group-hover:` …) must not carry both a
 * `bg-primary` fill and `text-white`. Coloured primary glows (`shadow-primary/NN`)
 * on those elements went too, and are banned on the shared storefront the same way.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '../..');
const SCAN = [join(ROOT, 'apps/web/src'), join(ROOT, 'packages/ui/src')];

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap(n => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(tsx|ts|css)$/.test(n) && !/\.test\./.test(n) ? [p] : [];
  });

/** Every className expression's text, and every @apply line. */
export function elements(src: string): Array<{ text: string; at: number }> {
  const out: Array<{ text: string; at: number }> = [];
  const re = /className=|@apply\s/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const start = m.index + m[0].length;
    if (m[0].startsWith('@apply')) {
      const end = src.indexOf(';', start);
      out.push({ text: src.slice(start, end), at: m.index });
      continue;
    }
    const open = src[start];
    if (open === '"' || open === "'") {
      out.push({ text: src.slice(start + 1, src.indexOf(open, start + 1)), at: m.index });
    } else if (open === '{') {
      let depth = 0;
      let i = start;
      for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) break;
      }
      out.push({ text: src.slice(start, i + 1), at: m.index });
    }
  }
  return out;
}

/** The pairing on one element: same variant prefix, primary fill + white text. */
export function pairs(text: string): string[] {
  const classes = text.split(/[\s'"`{}(),?]+/).filter(Boolean);
  const byPrefix = new Map<string, Set<string>>();
  for (const c of classes) {
    const i = c.lastIndexOf(':');
    const prefix = i === -1 ? '' : c.slice(0, i + 1);
    const base = (i === -1 ? c : c.slice(i + 1)).replace(/^!/, '');
    const kind = /^bg-primary(?:\/\d+)?$/.test(base)
      ? 'fill'
      : base === 'text-white'
        ? 'white'
        : null;
    if (!kind) continue;
    if (!byPrefix.has(prefix)) byPrefix.set(prefix, new Set());
    byPrefix.get(prefix)!.add(kind);
  }
  return [...byPrefix].filter(([, k]) => k.has('fill') && k.has('white')).map(([p]) => p || 'base');
}

const files = SCAN.flatMap(walk);
const lineOf = (src: string, at: number) => src.slice(0, at).split('\n').length;

describe('K-02: bg-primary is paired with text-primary-foreground', () => {
  it('scans the storefront and packages/ui', () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it('no element pairs a primary fill with white text', () => {
    const hits = files.flatMap(f => {
      const src = readFileSync(f, 'utf8');
      return elements(src).flatMap(e =>
        pairs(e.text).map(p => `${relative(ROOT, f)}:${lineOf(src, e.at)} (${p})`)
      );
    });
    expect(hits).toEqual([]);
  });

  // Shared storefront code only: a skin's documented hero CTA glow
  // (templates/modern|bold/DESIGN.md "CTA Glow") is skin identity, and the look
  // tokens that govern it are W2.
  const SKIN = /apps\/web\/src\/templates\/(?:modern|bold|classic|elegant|minimal|dahab)\//;
  it('no coloured primary glow on a shared storefront element', () => {
    const hits = files
      .filter(f => !SKIN.test(f))
      .flatMap(f => {
        const src = readFileSync(f, 'utf8');
        return elements(src)
          .filter(e => /(?:^|[\s'"`:])shadow-primary\/\d+/.test(e.text))
          .map(e => `${relative(ROOT, f)}:${lineOf(src, e.at)}`);
      });
    expect(hits).toEqual([]);
  });

  it('the matcher catches the old shapes and spares the on-token (self-test)', () => {
    const t = (s: string) => elements(s).flatMap(e => pairs(e.text));
    expect(t(`<a className="bg-primary text-white" />`)).toEqual(['base']);
    expect(t(`<a className={cn('h-10 bg-primary px-4', 'text-white')} />`)).toEqual(['base']);
    expect(t("<a className={`x ${on ? 'bg-primary text-white' : 'bg-muted'}`} />")).toEqual([
      'base',
    ]);
    expect(t(`<a className="hover:bg-primary hover:text-white" />`)).toEqual(['hover:']);
    expect(t(`.btn { @apply bg-primary text-white; }`)).toEqual(['base']);
    expect(t(`<a className="bg-primary/90 text-white" />`)).toEqual(['base']);
    expect(t(`<a className="bg-primary text-primary-foreground" />`)).toEqual([]);
    expect(
      t(`<a className="bg-gray-950 text-white hover:bg-primary hover:text-primary-foreground" />`)
    ).toEqual([]);
    expect(t(`<a className="bg-primary-foreground text-white" />`)).toEqual([]);
  });
});
