// @vitest-environment jsdom
/**
 * The inline editor's keyboard and clipboard contract (Arabic-first): field
 * direction, Enter vs IME composition, Escape, Tab, plain-text paste.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { startInlineEdit } from '../../apps/web/src/builder/preview/inline-edit';

const field = (over: Partial<{ key: string; dir: 'rtl' | 'ltr'; multiline: boolean }> = {}) => ({
  key: 'headlineAr',
  dir: 'rtl' as const,
  multiline: false,
  ...over,
});

function setup(text = 'تمور', f = field()) {
  document.body.innerHTML = `<h1 id="e">${text}</h1>`;
  const el = document.getElementById('e')!;
  const onCommit = vi.fn();
  const onMove = vi.fn();
  const onDone = vi.fn();
  startInlineEdit({ editable: el, field: f, caretColor: '#B08D57', onCommit, onMove, onDone });
  return { el, onCommit, onMove, onDone };
}
const key = (el: HTMLElement, init: KeyboardEventInit & { keyCode?: number }) => {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  if (init.keyCode) Object.defineProperty(e, 'keyCode', { value: init.keyCode });
  el.dispatchEvent(e);
  return e;
};

beforeEach(() => {
  document.execCommand = vi.fn(() => true);
});

describe('startInlineEdit', () => {
  it('takes the FIELD direction, plaintext bidi and a matching lang while editing, then restores', () => {
    const { el, onDone } = setup();
    expect(el.getAttribute('dir')).toBe('rtl');
    expect(el.getAttribute('lang')).toBe('ar');
    expect(el.style.unicodeBidi).toBe('plaintext');
    expect(el.isContentEditable || el.getAttribute('contenteditable')).toBeTruthy();
    key(el, { key: 'Escape' });
    expect(el.hasAttribute('dir')).toBe(false);
    expect(el.hasAttribute('contenteditable')).toBe(false);
    expect(el.style.unicodeBidi).toBe('');
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('an English field gets dir=ltr even when the page is Arabic', () => {
    const { el } = setup('Dates', field({ key: 'headline', dir: 'ltr' }));
    expect(el.getAttribute('dir')).toBe('ltr');
    expect(el.getAttribute('lang')).toBe('en');
  });

  it('Enter commits the trimmed text once', () => {
    const { el, onCommit } = setup();
    el.textContent = '  علب هدايا ';
    key(el, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('علب هدايا');
  });

  it('Enter does NOT commit while an IME composition is open (isComposing or keyCode 229)', () => {
    const { el, onCommit, onDone } = setup();
    el.textContent = 'م';
    key(el, { key: 'Enter', isComposing: true });
    key(el, { key: 'Enter', keyCode: 229 });
    expect(onCommit).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('Escape cancels and restores the original text', () => {
    const { el, onCommit } = setup();
    el.textContent = 'changed';
    key(el, { key: 'Escape' });
    expect(onCommit).not.toHaveBeenCalled();
    expect(el.textContent).toBe('تمور');
  });

  it('commits nothing when the text did not change', () => {
    const { el, onCommit } = setup();
    key(el, { key: 'Enter' });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('Tab commits and asks to move on; Shift+Tab moves back', () => {
    const a = setup();
    a.el.textContent = 'x';
    key(a.el, { key: 'Tab' });
    expect(a.onCommit).toHaveBeenCalledWith('x');
    expect(a.onMove).toHaveBeenCalledWith(1);
    const b = setup();
    key(b.el, { key: 'Tab', shiftKey: true });
    expect(b.onMove).toHaveBeenCalledWith(-1);
  });

  it('Shift+Enter is a newline only for a textarea setting', () => {
    const one = setup();
    const e1 = key(one.el, { key: 'Enter', shiftKey: true });
    expect(e1.defaultPrevented).toBe(true);
    expect(one.onCommit).not.toHaveBeenCalled();
    const many = setup('a', field({ multiline: true }));
    const e2 = key(many.el, { key: 'Enter', shiftKey: true });
    expect(e2.defaultPrevented).toBe(false);
  });

  it('paste inserts plain text only (single line folds newlines)', () => {
    const { el } = setup();
    const ev = new Event('paste', { bubbles: true, cancelable: true }) as Event & {
      clipboardData: { getData: (t: string) => string };
    };
    ev.clipboardData = {
      getData: t => (t === 'text/plain' ? 'سطر 1\nسطر 2' : '<b onclick=x>html</b>'),
    };
    el.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(document.execCommand).toHaveBeenCalledWith('insertText', false, 'سطر 1 سطر 2');
  });

  it('a drop never inserts markup', () => {
    const { el } = setup();
    const ev = new Event('drop', { bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });
});
