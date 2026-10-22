/**
 * In-place text editing for the builder canvas (DOM side; the rules for WHICH
 * text may be edited live in `overlay-logic.ts` / `@ebda/shared` canvas-targets).
 *
 * Arabic-first and RTL-correct:
 *  - the editable takes the FIELD's direction (`…Ar` -> rtl), not the page's,
 *    with `unicode-bidi: plaintext` and a matching `lang`;
 *  - Enter commits, but never while an IME composition is open (`isComposing`,
 *    or keyCode 229 on engines that report it that way);
 *  - Shift+Enter is a newline only for `textarea` settings;
 *  - Escape cancels and restores the text; Tab / Shift+Tab commit and ask the
 *    overlay for the next / previous text target;
 *  - paste and drop insert PLAIN TEXT only (no HTML ever enters the page);
 *  - the value is read from `innerText`, never `innerHTML`.
 * The result leaves as an intent (`patch-text`); the parent validates it.
 */
import type { TextTarget } from '@ebda/shared';

export interface InlineEditOptions {
  editable: HTMLElement;
  field: TextTarget;
  /** Selection outline colour while editing. */
  caretColor: string;
  /** The user committed: `value` is trimmed text, only sent when it changed. */
  onCommit: (value: string) => void;
  /** Tab (1) or Shift+Tab (-1): called AFTER the commit. */
  onMove: (direction: 1 | -1) => void;
  /** Called once when editing ends, however it ended. */
  onDone?: () => void;
  /** Client coordinates of the click that opened the editor, to place the caret. */
  point?: { x: number; y: number };
}

const readText = (el: HTMLElement): string =>
  ((el as HTMLElement & { innerText?: string }).innerText ?? el.textContent ?? '').replace(
    / /g,
    ' '
  );

function placeCaret(el: HTMLElement, point?: { x: number; y: number }) {
  const sel = el.ownerDocument.getSelection();
  if (!sel) return;
  let range: Range | null = null;
  const doc = el.ownerDocument as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  if (point && typeof doc.caretRangeFromPoint === 'function') {
    const r = doc.caretRangeFromPoint(point.x, point.y);
    if (r && el.contains(r.startContainer)) range = r;
  }
  if (!range) {
    range = el.ownerDocument.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
  }
  sel.removeAllRanges();
  sel.addRange(range);
}

export function startInlineEdit(opts: InlineEditOptions): { cancel: () => void } {
  const { editable, field } = opts;
  const before = readText(editable);
  const saved = {
    contentEditable: editable.getAttribute('contenteditable'),
    dir: editable.getAttribute('dir'),
    lang: editable.getAttribute('lang'),
    unicodeBidi: editable.style.unicodeBidi,
    outline: editable.style.outline,
    outlineOffset: editable.style.outlineOffset,
  };

  editable.setAttribute('contenteditable', 'plaintext-only');
  // Engines without plaintext-only ignore the value; fall back to 'true' (paste/drop stay plain).
  if (editable.isContentEditable === false) editable.setAttribute('contenteditable', 'true');
  editable.setAttribute('dir', field.dir);
  editable.setAttribute('lang', field.dir === 'rtl' ? 'ar' : 'en');
  editable.style.unicodeBidi = 'plaintext';
  editable.style.outline = `2px solid ${opts.caretColor}`;
  editable.style.outlineOffset = '2px';
  editable.focus();
  placeCaret(editable, opts.point);

  let finished = false;
  const restore = () => {
    if (saved.contentEditable === null) editable.removeAttribute('contenteditable');
    else editable.setAttribute('contenteditable', saved.contentEditable);
    if (saved.dir === null) editable.removeAttribute('dir');
    else editable.setAttribute('dir', saved.dir);
    if (saved.lang === null) editable.removeAttribute('lang');
    else editable.setAttribute('lang', saved.lang);
    editable.style.unicodeBidi = saved.unicodeBidi;
    editable.style.outline = saved.outline;
    editable.style.outlineOffset = saved.outlineOffset;
    editable.removeEventListener('blur', onBlur);
    editable.removeEventListener('keydown', onKey);
    editable.removeEventListener('paste', onPaste);
    editable.removeEventListener('drop', onDrop);
  };
  const finish = (commit: boolean) => {
    if (finished) return;
    finished = true;
    const value = readText(editable).trim();
    restore();
    if (!commit) editable.textContent = before;
    else if (value !== before.trim()) opts.onCommit(value);
    opts.onDone?.();
  };

  const onBlur = () => finish(true);
  const onKey = (e: KeyboardEvent) => {
    // An open IME composition owns Enter / Tab / Escape: they confirm the candidate.
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') {
      if (e.shiftKey && field.multiline) return; // a real newline
      e.preventDefault();
      if (e.shiftKey) return; // single line: Shift+Enter does nothing
      finish(true);
      editable.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      finish(false);
      editable.blur();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      finish(true);
      opts.onMove(e.shiftKey ? -1 : 1);
    }
  };
  const onPaste = (e: ClipboardEvent) => {
    e.preventDefault();
    const text = e.clipboardData?.getData('text/plain') ?? '';
    const clean = field.multiline ? text : text.replace(/\s*[\r\n]+\s*/g, ' ');
    editable.ownerDocument.execCommand('insertText', false, clean);
  };
  const onDrop = (e: DragEvent) => e.preventDefault();
  editable.addEventListener('blur', onBlur);
  editable.addEventListener('keydown', onKey);
  editable.addEventListener('paste', onPaste);
  editable.addEventListener('drop', onDrop);
  return { cancel: () => finish(false) };
}
