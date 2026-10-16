// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import React, { act } from 'react';
import { renderToString } from 'react-dom/server';
import { hydrateRoot } from 'react-dom/client';

vi.mock('../../contexts/LanguageContext', () => ({
  useLanguage: () => ({ isRtl: false, t: (en: string) => en }),
}));
import { ShareProductRow } from './ShareProductRow';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('ShareProductRow hydration (B0-46)', () => {
  it('server markup does not depend on window, and the client fills the URL in after hydration', async () => {
    const el = <ShareProductRow productName="Kaftan" />;
    // renderToString runs without a window snapshot: the server value is ''.
    const serverHtml = renderToString(el);
    expect(serverHtml).not.toContain(encodeURIComponent(window.location.href));
    expect(serverHtml).not.toContain('undefined');

    const container = document.createElement('div');
    container.innerHTML = serverHtml;
    document.body.appendChild(container);
    const recoverable = vi.fn();
    await act(async () => {
      hydrateRoot(container, el, { onRecoverableError: recoverable });
    });
    expect(recoverable).not.toHaveBeenCalled();
    const wa = container.querySelector('a[href^="https://wa.me/"]') as HTMLAnchorElement;
    expect(wa.href).toContain(encodeURIComponent(window.location.href));
  });

  it('an explicit url still wins', () => {
    const html = renderToString(<ShareProductRow productName="K" url="https://shop.example/p/k" />);
    expect(html).toContain(encodeURIComponent('https://shop.example/p/k'));
  });
});
