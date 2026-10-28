'use client';

import { useEffect } from 'react';

/**
 * The static 404.html serves /en/... too. After hydration (the client may re-render the document for the
 * unknown URL, discarding what the early inline script set), pick the language of the URL: the `html[data-nf]`
 * CSS shows the matching block, and the tab title follows.
 */
export function NotFoundLang() {
  useEffect(() => {
    const en = /^\/en(\/|$)/.test(window.location.pathname);
    const d = document.documentElement;
    d.setAttribute('data-nf', en ? 'en' : 'ar');
    if (en) {
      d.lang = 'en';
      d.dir = 'ltr';
      document.title = 'Page not found | Ebda AI Studio';
    }
  }, []);
  return null;
}
