// @vitest-environment jsdom
/**
 * The canvas is inert (`editor-inert.ts`): ONE layer, so a component nobody has seen yet cannot act
 * inside the builder. Drives the real layer in a DOM with React-style listeners on the root.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { installEditorInert } from '../../apps/web/src/builder/preview/editor-inert';

let undo: () => void;
const rootClick = vi.fn(); // stands in for React's root listener (bubble phase)
const rootSubmit = vi.fn();
const rootChange = vi.fn();
const realFetch = vi.fn(async () => new Response('{"ok":true}'));

beforeEach(() => {
  window.fetch = realFetch as unknown as typeof window.fetch;
  document.body.innerHTML = `
    <div id="root">
      <a id="link" href="/products/x">p</a>
      <button id="add" type="button">add</button>
      <form id="f"><input id="q" name="q"><button id="go" type="submit">go</button></form>
      <select id="sort"><option>a</option><option>b</option></select>
      <input id="chk" type="checkbox">
      <details><summary id="sum">more</summary>body</details>
      <p id="edit" contenteditable="plaintext-only">text</p>
      <div data-builder-toolbar-root><button id="own" type="button">up</button></div>
    </div>`;
  const root = document.getElementById('root')!;
  root.addEventListener('click', rootClick);
  root.addEventListener('submit', rootSubmit);
  root.addEventListener('change', rootChange);
  [rootClick, rootSubmit, rootChange, realFetch].forEach(m => m.mockClear());
  undo = installEditorInert();
});
afterEach(() => undo());

const click = (id: string) => {
  const e = new MouseEvent('click', { bubbles: true, cancelable: true });
  document.getElementById(id)!.dispatchEvent(e);
  return e;
};

describe('editor inert layer', () => {
  it('no storefront click handler runs, and links / submit buttons / toggles lose their default', () => {
    for (const id of ['link', 'add', 'go', 'chk']) {
      const e = click(id);
      expect(e.defaultPrevented, id).toBe(true);
    }
    expect(rootClick).not.toHaveBeenCalled();
  });

  it('a form never submits and its handler never runs; a select / checkbox change reaches nobody', () => {
    const f = document.getElementById('f')!;
    const s = new Event('submit', { bubbles: true, cancelable: true });
    f.dispatchEvent(s);
    expect(s.defaultPrevented).toBe(true);
    expect(rootSubmit).not.toHaveBeenCalled();
    document.getElementById('sort')!.dispatchEvent(new Event('change', { bubbles: true }));
    expect(rootChange).not.toHaveBeenCalled();
  });

  it('keeps what the editor needs: the overlay controls, text being edited, native <details>', () => {
    click('own');
    click('edit');
    expect(rootClick).toHaveBeenCalledTimes(2);
    expect(click('sum').defaultPrevented).toBe(false); // the summary still toggles
    expect(rootClick).toHaveBeenCalledTimes(2); // but no storefront handler ran for it
  });

  it('refuses every mutating request in the one place they go through, and lets reads pass', async () => {
    for (const init of [
      { method: 'POST' },
      { method: 'put' },
      { method: 'DELETE' },
      { method: 'PATCH' },
    ]) {
      const r = await fetch('/api/v1/public/cart/items', init);
      expect(r.status).toBe(409);
      expect((await r.json()).error.code).toBe('EDITOR_MODE');
    }
    await fetch('/api/v1/public/cart');
    await fetch('/api/v1/public/products', { method: 'GET' });
    expect(realFetch).toHaveBeenCalledTimes(2);
    expect(navigator.sendBeacon?.('/x', 'y') ?? true).toBe(true);
    expect(window.open('/x')).toBeNull();
  });

  it('uninstalls cleanly', async () => {
    undo();
    expect(click('add').defaultPrevented).toBe(false);
    expect(rootClick).toHaveBeenCalledTimes(1);
    await fetch('/x', { method: 'POST' });
    expect(realFetch).toHaveBeenCalledTimes(1);
    undo = installEditorInert();
  });
});
