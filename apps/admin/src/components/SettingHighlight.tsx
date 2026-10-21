'use client';

import { useEffect } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { locateAndHighlight } from '../lib/setting-highlight';
import { isKnownSettingId } from '../lib/settings-search';

/**
 * Renders nothing. When the URL carries `?setting=<id>` (a result of the ⌘K palette or the
 * Settings search box) it scrolls to the control marked `data-setting-id="<id>"` and rings it.
 * The tab that holds the control is selected by the page itself from `?tab=`. Mounted once, in
 * AdminLayout, inside a Suspense boundary (useSearchParams).
 */
export function SettingHighlight() {
  const params = useSearchParams();
  const pathname = usePathname();
  const id = params.get('setting');
  const tab = params.get('tab');

  useEffect(() => {
    // `?setting=` is untrusted: only an id the registry knows is looked up (a crafted value does nothing).
    if (!isKnownSettingId(id)) return;
    return locateAndHighlight(id);
    // `tab` and `pathname` re-run it when the same page switches tab for another result.
  }, [id, tab, pathname]);

  return null;
}
