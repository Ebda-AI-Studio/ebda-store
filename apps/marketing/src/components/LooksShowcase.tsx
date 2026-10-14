'use client';

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { LooksCopy } from '../lib/content';
import { ensureLookFont, parseFragment, type Frag } from '../lib/looks-frag';
import { mountPhones } from '../lib/phone-store-dom';
import { SIGNUP_URL } from '../lib/site';

const LETTERS = ['A', 'B', 'C'] as const;

/**
 * Pick a template, see its three looks as working mini-stores in phones (Ruling MKT-8): the
 * product page, category filters, cart and the demo checkout are driven by phone-store-dom.ts
 * over the data attributes the generator emits. The first template's markup is rendered by the
 * server; the others are fetched from /looks on first select. Links inside the phones do nothing.
 */
export function LooksShowcase({
  copy,
  rtl,
  initialHtml,
}: {
  copy: LooksCopy;
  rtl: boolean;
  initialHtml: string;
}) {
  const firstId = copy.templates[0].id;
  const [active, setActive] = useState(firstId);
  const [frags, setFrags] = useState<Record<string, Frag>>(() =>
    initialHtml ? { [firstId]: parseFragment(initialHtml) } : {}
  );
  const [failed, setFailed] = useState<string | null>(null);
  const [current, setCurrent] = useState(0);
  const [seen, setSeen] = useState(false);
  const [switched, setSwitched] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const load = useCallback((id: string) => {
    setFailed(null);
    fetch(`/looks/${id}`)
      .then(r => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then(t => setFrags(f => ({ ...f, [id]: parseFragment(t) })))
      .catch(() => setFailed(id));
  }, []);

  useEffect(() => {
    if (!frags[active] && failed !== active) load(active);
  }, [active, frags, failed, load]);

  // Fonts: only once the section is near the screen (or a tab was chosen), once per template.
  useEffect(() => {
    const el = stageRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return setSeen(true);
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          setSeen(true);
          io.disconnect();
        }
      },
      { rootMargin: '600px 0px' }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    if (seen) ensureLookFont(active);
  }, [active, seen]);

  // Which look the A/B/C switch shows follows the snap scroll.
  useEffect(() => {
    const track = trackRef.current;
    if (!track || typeof IntersectionObserver === 'undefined') return;
    const items = [...track.children] as HTMLElement[];
    const io = new IntersectionObserver(
      entries => {
        for (const e of entries)
          if (e.isIntersecting && e.intersectionRatio > 0.6)
            setCurrent(items.indexOf(e.target as HTMLElement));
      },
      { root: track, threshold: [0.6] }
    );
    items.forEach(i => io.observe(i));
    return () => io.disconnect();
  }, [active, frags]);

  const select = (id: string, focus = false) => {
    setSeen(true);
    setSwitched(true);
    setActive(id);
    setCurrent(0);
    trackRef.current?.scrollTo({ left: 0 });
    if (focus) tabRefs.current[copy.templates.findIndex(t => t.id === id)]?.focus();
  };

  const onTabKey = (e: KeyboardEvent, i: number) => {
    const n = copy.templates.length;
    // In RTL the tab row is mirrored: the visual right arrow goes to the previous tab.
    const fwd = rtl ? 'ArrowLeft' : 'ArrowRight';
    const back = rtl ? 'ArrowRight' : 'ArrowLeft';
    let next = -1;
    if (e.key === fwd) next = (i + 1) % n;
    else if (e.key === back) next = (i - 1 + n) % n;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n - 1;
    if (next < 0) return;
    e.preventDefault();
    select(copy.templates[next].id, true);
  };

  const goTo = (i: number) => {
    const el = trackRef.current?.children[i] as HTMLElement | undefined;
    el?.scrollIntoView({ inline: 'start', block: 'nearest', behavior: 'smooth' });
    setCurrent(i);
  };

  // Each phone becomes a working store once its markup is in the DOM; the cleanup removes every
  // listener and layer, so switching template (or a Strict Mode remount) never leaves one behind.
  const activeFrag = frags[active];
  useEffect(() => {
    const track = trackRef.current;
    if (!track || !activeFrag) return;
    return mountPhones(track, { signupUrl: SIGNUP_URL });
  }, [active, activeFrag]);

  const tpl = copy.templates.find(t => t.id === active) ?? copy.templates[0];
  const items = copy.items[active];
  const frag = frags[active];

  return (
    <div className="looks-wrap" ref={stageRef}>
      <div className="looks-tabs" role="tablist" aria-label={copy.tablistLabel}>
        {copy.templates.map((t, i) => (
          <button
            key={t.id}
            ref={el => {
              tabRefs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`looks-tab-${t.id}`}
            aria-selected={t.id === active}
            aria-controls="looks-panel"
            tabIndex={t.id === active ? 0 : -1}
            className="looks-tab"
            onClick={() => select(t.id)}
            onKeyDown={e => onTabKey(e, i)}
          >
            <span className="looks-tab-name">{t.name}</span>
            <span className="looks-tab-kind">{t.kind}</span>
          </button>
        ))}
      </div>

      <div
        id="looks-panel"
        role="tabpanel"
        aria-labelledby={`looks-tab-${active}`}
        aria-busy={!frag && failed !== active}
        className="looks-panel"
      >
        <p className="looks-kind">{tpl.kind}</p>
        <div className="looks-switch" role="group" aria-label={copy.switchLabel}>
          {items.map((it, i) => (
            <button
              key={LETTERS[i]}
              type="button"
              className="looks-switch-btn"
              aria-pressed={current === i}
              aria-label={`${copy.switchLabel} ${LETTERS[i]}: ${it.name}`}
              onClick={() => goTo(i)}
            >
              {LETTERS[i]}
            </button>
          ))}
        </div>
        {frag && <style dangerouslySetInnerHTML={{ __html: frag.css }} />}
        {frag ? (
          <div
            className={`looks-trio${switched ? ' looks-trio-in' : ''}`}
            key={active}
            ref={trackRef}
          >
            {items.map((it, i) => (
              <figure className="looks-item" key={LETTERS[i]}>
                <div className="look-phone">
                  <span className="look-badge">{copy.badge}</span>
                  <div
                    className="look-screen"
                    dangerouslySetInnerHTML={{ __html: frag.looks[i] ?? '' }}
                  />
                </div>
                <figcaption>
                  <h3>
                    <span className="look-letter" aria-hidden="true">
                      {LETTERS[i]}
                    </span>
                    {it.name}
                  </h3>
                  <p className="look-who">{it.who}</p>
                  <p className="look-idea">
                    <b>{copy.ideaLabel}:</b> {it.idea}
                  </p>
                </figcaption>
              </figure>
            ))}
          </div>
        ) : (
          <div className="looks-empty" role="status">
            {failed === active ? (
              <>
                <span>{copy.failed}</span>{' '}
                <button type="button" className="btn btn-ghost" onClick={() => load(active)}>
                  {copy.retry}
                </button>
              </>
            ) : (
              copy.loading
            )}
          </div>
        )}
      </div>
      {copy.bilingualNote && <p className="muted looks-note">{copy.bilingualNote}</p>}
    </div>
  );
}
