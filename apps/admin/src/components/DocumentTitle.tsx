'use client';

import { useEffect } from 'react';
import { useLocale } from 'next-intl';
import { pageTitle } from '@/lib/product-name';

/**
 * Client routes cannot export `metadata`, so each surface that has a heading
 * mirrors it into `<title>` as "<page> · Ebda Store" / «<الصفحة> · ابدأ ستور».
 * Next re-writes the metadata `<title>` after hydration/streaming, so the value
 * is re-applied whenever <head> changes until the surface unmounts.
 */
export function DocumentTitle({ title }: { title?: string | null }) {
  const locale = useLocale();
  const next = pageTitle(title, locale);
  useEffect(() => {
    const apply = () => {
      if (document.title !== next) document.title = next;
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [next]);
  return null;
}
