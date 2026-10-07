'use client';

/**
 * "Add section" picker: every registry type allowed in the chosen group,
 * one card per PRESET with a schematic preview, the bilingual name, and a
 * disabled state (with the reason) when the type is at its cardinality cap.
 * Inserting goes through the reducer, which owns the invariants.
 */
import { useEffect, useRef } from 'react';
import { useLocale } from 'next-intl';
import { SECTION_REGISTRY, type PageDefinition, type SectionList } from '@force/shared';
import { useT } from '@/i18n/useT';
import { SectionThumb } from './SectionThumb';

interface Props {
  list: SectionList;
  doc: PageDefinition;
  onPick: (sectionType: string, presetIndex: number) => void;
  onClose: () => void;
}

export function AddSectionDialog({ list, doc, onPick, onClose }: Props) {
  const t = useT('builder.addSection');
  const locale = useLocale();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  const count = (type: string) =>
    [...doc.sectionGroups.header, ...doc.sections, ...doc.sectionGroups.footer].filter(
      n => n.type === type
    ).length;
  const types = SECTION_REGISTRY.filter(d => d.group === list);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={onClose}
      aria-labelledby="add-section-title"
      className="w-[min(56rem,calc(100vw-2rem))] rounded-2xl border border-border bg-card p-0 text-foreground backdrop:bg-black/60"
      data-testid="add-section-dialog"
    >
      <div className="flex items-center justify-between border-b border-border px-5 py-3">
        <h2 id="add-section-title" className="text-base font-semibold">
          {t('title')}
        </h2>
        <button
          type="button"
          onClick={onClose}
          className="rounded px-2 py-1 text-sm hover:bg-muted"
        >
          {t('close')}
        </button>
      </div>
      <ul className="grid max-h-[70vh] grid-cols-1 gap-3 overflow-y-auto p-5 sm:grid-cols-2 lg:grid-cols-3">
        {types.flatMap(d =>
          d.presets.map((p, i) => {
            const full = count(d.type) >= d.maxCount;
            const name = locale === 'ar' ? p.nameAr : p.nameEn;
            return (
              <li key={`${d.type}-${i}`}>
                <button
                  type="button"
                  disabled={full}
                  onClick={() => onPick(d.type, i)}
                  className="w-full rounded-xl border border-border bg-background p-3 text-start hover:border-primary disabled:cursor-not-allowed disabled:opacity-50"
                  data-testid={`preset-${d.type}-${i}`}
                >
                  <SectionThumb type={d.type} settings={p.settings} />
                  <span className="mt-2 block text-sm font-medium">{name}</span>
                  <span className="block text-xs text-muted-foreground">
                    {full
                      ? t('limitReached', { max: d.maxCount })
                      : locale === 'ar'
                        ? d.labelAr
                        : d.labelEn}
                  </span>
                </button>
              </li>
            );
          })
        )}
      </ul>
    </dialog>
  );
}
