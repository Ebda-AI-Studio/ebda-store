'use client';

/**
 * Font family picker (plan F9): every family is listed in its own face, with a search box once the list is long.
 * Library fonts (typography.fonts) come first; two built-in stacks are always offered; a stored value that is in
 * neither list stays visible as its own entry, so nothing a merchant typed before is lost. The value written is
 * the family name, exactly like the old text field. Google entries get their stylesheet linked so the specimen
 * is the real face (once per URL).
 */
import { useEffect, useId, useMemo, useState } from 'react';
import { useT } from '@/i18n/useT';
import { Chevron, TextInput, fieldControlClasses } from '../ui/Field';
import { cn } from '@ebda/ui/cn';

export interface PickerFont {
  family: string;
  url?: string;
  type?: 'google' | 'custom';
}

const unquote = (v: string) => v.trim().replace(/^["']|["']$/g, '');

function linkGoogleFonts(fonts: PickerFont[]) {
  if (typeof document === 'undefined') return;
  for (const f of fonts) {
    if (f.type !== 'google' || !f.url || !/^https:\/\/fonts\.googleapis\.com\//.test(f.url))
      continue;
    const known = Array.from(document.head.querySelectorAll('link[data-picker-font]'));
    if (known.some(l => l.getAttribute('data-picker-font') === f.url)) continue;
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = f.url;
    l.setAttribute('data-picker-font', f.url);
    document.head.appendChild(l);
  }
}

export function FontPicker({
  value,
  fonts,
  onChange,
  label,
}: {
  value: string;
  fonts: PickerFont[];
  onChange: (family: string) => void;
  label: string;
}) {
  const t = useT('zoneEditor');
  const id = useId();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  useEffect(() => linkGoogleFonts(fonts), [fonts]);

  const options = useMemo(() => {
    const own = fonts.map(f => ({
      family: f.family,
      name: f.family,
      face: `"${f.family}", system-ui`,
    }));
    const builtin = [
      { family: 'system-ui', name: t('fontBuiltinSans'), face: 'system-ui, sans-serif' },
      { family: 'Georgia', name: t('fontBuiltinSerif'), face: 'Georgia, serif' },
    ];
    const all = [...own, ...builtin];
    const cur = unquote(value);
    if (cur && !all.some(o => o.family === cur))
      all.unshift({ family: cur, name: cur, face: `"${cur}", system-ui` });
    return all;
  }, [fonts, value, t]);

  const shown = q.trim()
    ? options.filter(o => o.name.toLowerCase().includes(q.trim().toLowerCase()))
    : options;
  const cur = options.find(o => o.family === unquote(value));
  const pick = (family: string) => {
    onChange(family);
    setOpen(false);
    setQ('');
  };

  return (
    <div className="min-w-0">
      <button
        type="button"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        onClick={() => setOpen(o => !o)}
        className={fieldControlClasses('flex items-center justify-between gap-2 text-start')}
      >
        <span className="min-w-0 truncate" style={cur ? { fontFamily: cur.face } : undefined}>
          {cur ? cur.name : t('same')}
        </span>
        <Chevron
          className={cn(
            'h-4 w-4 shrink-0 text-muted-ink transition-transform duration-150 motion-reduce:transition-none',
            open && 'rotate-180'
          )}
        />
      </button>
      {open && (
        <div className="mt-1 rounded-md border border-border bg-card p-1 shadow-md">
          {options.length > 6 && (
            <TextInput
              type="search"
              value={q}
              onChange={e => setQ(e.target.value)}
              placeholder={t('searchFonts')}
              aria-label={t('searchFonts')}
              className="mb-1"
            />
          )}
          <ul
            id={`${id}-list`}
            role="listbox"
            aria-label={label}
            className="max-h-56 overflow-y-auto"
          >
            <li role="option" aria-selected={!cur}>
              <button
                data-ui="row"
                type="button"
                onClick={() => pick('')}
                className="flex min-h-10 w-full items-center rounded-md px-3 text-start text-sm text-muted-ink hover:bg-accent"
              >
                {t('same')}
              </button>
            </li>
            {shown.map(o => (
              <li key={o.family} role="option" aria-selected={cur?.family === o.family}>
                <button
                  data-ui="row"
                  type="button"
                  onClick={() => pick(o.family)}
                  style={{ fontFamily: o.face }}
                  className={cn(
                    'flex min-h-10 w-full items-center justify-between gap-2 rounded-md px-3 text-start text-base hover:bg-accent',
                    cur?.family === o.family && 'bg-primary/15 text-primary-ink'
                  )}
                >
                  <span className="min-w-0 truncate">{o.name}</span>
                  <span aria-hidden="true" className="shrink-0 text-sm text-muted-ink">
                    {t('specimen')}
                  </span>
                </button>
              </li>
            ))}
            {shown.length === 0 && (
              <li className="px-3 py-2 text-sm text-muted-ink">{t('noFontMatch')}</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
