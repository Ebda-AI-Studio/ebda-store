'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Copy } from '../lib/content';
import { ensureLookFont, parseFragment, type Frag } from '../lib/looks-frag';

const INTERVAL_MS = 4000;
/** Ids inside a fragment are `ph-<template>-<look>`; the hero copy renames them so the page keeps unique ids. */
const retag = (s: string) => s.replace(/ph-/g, 'hp-');
/** The first frame is the page's largest image above the fold: fetched eagerly with high priority, not lazily. */
const prioritise = (s: string) => s.replace('loading="lazy"', 'fetchpriority="high"');

/**
 * The hero's one phone: the first look of each template, cycling. The server renders the
 * first frame (Qamar, look A), so no-JS and reduced-motion visitors see a finished static
 * phone; the other four fragments are fetched after load and the cycle starts only when the
 * visitor has not asked for reduced motion. It pauses on hover and on focus, has a visible
 * pause button, and the dots jump to a template. The phone is decorative (inert): the
 * interactive version is the looks section right below.
 */
export function HeroPhone({
  copy,
  templates,
  initialHtml,
}: {
  copy: Copy['hero']['phone'];
  templates: { id: string; name: string; kind: string }[];
  initialHtml: string;
}) {
  const firstId = templates[0].id;
  const [frags, setFrags] = useState<Record<string, Frag>>(() =>
    initialHtml ? { [firstId]: parseFragment(initialHtml) } : {}
  );
  const [idx, setIdx] = useState(0);
  const [userPaused, setUserPaused] = useState(false);
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [reduced, setReduced] = useState(true); // true until proven otherwise: static first frame
  const [hidden, setHidden] = useState(false);
  const asked = useRef(new Set<string>([firstId]));

  const load = useCallback((id: string) => {
    if (asked.current.has(id)) return;
    asked.current.add(id);
    fetch(`/looks/${id}`)
      .then(r => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then(t => setFrags(f => ({ ...f, [id]: parseFragment(t) })))
      .catch(() => asked.current.delete(id));
  }, []);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const on = () => setReduced(mq.matches);
    mq.addEventListener('change', on);
    const vis = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', vis);
    return () => {
      mq.removeEventListener('change', on);
      document.removeEventListener('visibilitychange', vis);
    };
  }, []);

  // Fetch the other fragments once the page is idle (never on the critical path).
  useEffect(() => {
    if (reduced) return;
    const go = () => templates.slice(1).forEach(t => load(t.id));
    const ric = (window as unknown as { requestIdleCallback?: (cb: () => void) => number })
      .requestIdleCallback;
    const h = ric ? ric(go) : window.setTimeout(go, 2500);
    return () => {
      if (!ric) window.clearTimeout(h);
    };
  }, [reduced, templates, load]);

  const playing = !reduced && !userPaused && !hover && !focus && !hidden;
  useEffect(() => {
    if (!playing) return;
    const t = window.setTimeout(() => {
      const next = (idx + 1) % templates.length;
      load(templates[next].id);
      if (frags[templates[next].id]) setIdx(next);
    }, INTERVAL_MS);
    return () => window.clearTimeout(t);
  }, [playing, idx, frags, templates, load]);

  const t = templates[idx];
  const frag = frags[t.id];
  useEffect(() => {
    if (frag && idx > 0) ensureLookFont(t.id);
  }, [frag, idx, t.id]);

  const jump = (i: number) => {
    load(templates[i].id);
    ensureLookFont(templates[i].id);
    if (frags[templates[i].id]) setIdx(i);
  };

  return (
    <div
      className="hero-phone"
      role="group"
      aria-roledescription="carousel"
      aria-label={copy.label}
      onFocus={() => setFocus(true)}
      onBlur={() => setFocus(false)}
    >
      <div
        className="look-phone"
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      >
        <span className="look-badge">{copy.badge}</span>
        {frag && <style dangerouslySetInnerHTML={{ __html: retag(frag.css) }} />}
        <div
          className="look-screen"
          key={t.id}
          data-fade={idx > 0 ? '' : undefined}
          aria-hidden="true"
          // The preview is decorative: nothing inside it is focusable or announced.
          {...({ inert: '' } as object)}
          dangerouslySetInnerHTML={{
            __html:
              idx === 0 ? prioritise(retag(frag?.looks[0] ?? '')) : retag(frag?.looks[0] ?? ''),
          }}
        />
      </div>
      <div className="hero-phone-bar">
        <p className="hero-phone-name" aria-live={playing ? 'off' : 'polite'}>
          <b>{t.name}</b> <span>{t.kind}</span>
        </p>
        <div className="hero-phone-ctl">
          {!reduced && (
            <button
              type="button"
              className="hero-phone-pause"
              aria-pressed={userPaused}
              onClick={() => setUserPaused(p => !p)}
              aria-label={userPaused ? copy.play : copy.pause}
            >
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                {userPaused ? (
                  <path d="M8 5.5v13l11-6.5z" fill="currentColor" />
                ) : (
                  <path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor" />
                )}
              </svg>
            </button>
          )}
          <div className="hero-phone-dots">
            {templates.map((x, i) => (
              <button
                key={x.id}
                type="button"
                className="hero-phone-dot"
                aria-label={copy.show.replace('{name}', x.name)}
                aria-current={i === idx}
                onClick={() => jump(i)}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
