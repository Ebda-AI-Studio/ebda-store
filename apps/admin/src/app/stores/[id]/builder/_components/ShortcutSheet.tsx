'use client';

/**
 * The editor's keyboard-shortcut sheet: `?` opens it, Escape closes it, focus goes back to where it
 * was. Lists only shortcuts the editor really handles (BuilderEditor: undo / redo; SectionTree:
 * Alt+arrows, Enter; AddSectionDialog: `/`; the tab strip: arrows). A native `<dialog>` like
 * ConfirmDialog, so Escape, the focus trap and scroll lock come from the platform.
 */
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/useT';
import { useIsMac } from '../_lib/use-is-mac';
import { useRestoreFocus } from '../_lib/use-restore-focus';

/** True when a `?` press is the merchant typing, or a modal already owns the keyboard. */
function shouldIgnore(e: KeyboardEvent): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey) return true;
  const el = e.target as HTMLElement | null;
  if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return true;
  return !!document.querySelector('dialog[open]');
}

export function ShortcutSheet() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '?' || shouldIgnore(e)) return;
      e.preventDefault();
      setOpen(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return open ? <Sheet onClose={() => setOpen(false)} /> : null;
}

function Keys({ keys }: { keys: string[] }) {
  return (
    <span className="flex shrink-0 items-center gap-1" dir="ltr">
      {keys.map(k => (
        <kbd
          key={k}
          className="rounded-md border border-border bg-muted px-1.5 py-0.5 text-xs font-medium tabular-nums text-foreground"
        >
          {k}
        </kbd>
      ))}
    </span>
  );
}

function Sheet({ onClose }: { onClose: () => void }) {
  const t = useT('builder.shortcuts');
  const mac = useIsMac();
  useRestoreFocus();
  const mod = mac ? '⌘' : 'Ctrl';
  const rows: Array<{ id: string; keys: string[] }> = [
    { id: 'undo', keys: [mod, 'Z'] },
    { id: 'redo', keys: mac ? ['⇧', '⌘', 'Z'] : ['Ctrl', 'Shift', 'Z'] },
    { id: 'move', keys: [mac ? '⌥' : 'Alt', '↑ ↓'] },
    { id: 'canvas', keys: ['Enter'] },
    { id: 'tabs', keys: ['← →'] },
    { id: 'search', keys: ['/'] },
    { id: 'esc', keys: ['Esc'] },
    { id: 'help', keys: ['?'] },
  ];
  return (
    <dialog
      ref={el => {
        if (el && !el.open) el.showModal();
      }}
      onCancel={onClose}
      onClose={onClose}
      aria-labelledby="shortcuts-title"
      className="editor-motion-dialog w-[min(28rem,calc(100vw-2rem))] rounded-2xl border border-border bg-card p-0 text-foreground backdrop:bg-black/60"
      data-testid="shortcut-sheet"
    >
      <div className="space-y-3 p-5">
        <h2 id="shortcuts-title" className="text-base font-semibold">
          {t('title')}
        </h2>
        <dl className="divide-y divide-border">
          {rows.map(r => (
            <div key={r.id} className="flex items-center justify-between gap-3 py-2 text-sm">
              <dt>{t(r.id)}</dt>
              <dd>
                <Keys keys={r.keys} />
              </dd>
            </div>
          ))}
        </dl>
        <div className="flex justify-end pt-1">
          <Button variant="ghost" type="button" onClick={onClose} autoFocus>
            {t('close')}
          </Button>
        </div>
      </div>
    </dialog>
  );
}
