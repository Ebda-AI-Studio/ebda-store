'use client';

/**
 * "Add section" picker: every registry type allowed in the chosen group,
 * one card per PRESET with a schematic preview, the bilingual name, and a
 * disabled state (with the reason) when the type is at its cardinality cap.
 * Inserting goes through the reducer, which owns the invariants.
 */
import { Button } from '@/components/ui/Button';
import { useEffect, useRef } from 'react';
import { useLocale } from 'next-intl';
import {
  SECTION_REGISTRY,
  sectionAllowedOnPage,
  type PageDefinition,
  type SectionList,
} from '@ebda/shared';
import { useT } from '@/i18n/useT';
import { flowOrder, orderByFlow } from '../../../../../lib/builder-flow-order';
import { SectionThumb } from './SectionThumb';
import { useRestoreFocus } from '../_lib/use-restore-focus';

interface Props {
  list: SectionList;
  doc: PageDefinition;
  /** The store's template and look: its own section types are listed first, in storefront order. */
  template?: string | null;
  look?: string | null;
  onPick: (sectionType: string, presetIndex: number) => void;
  onClose: () => void;
}

export function AddSectionDialog({ list, doc, template, look, onPick, onClose }: Props) {
  const t = useT('builder.addSection');
  const locale = useLocale();
  const ref = useRef<HTMLDialogElement>(null);
  useRestoreFocus();
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  const count = (type: string) =>
    [...doc.sectionGroups.header, ...doc.sections, ...doc.sectionGroups.footer].filter(
      n => n.type === type
    ).length;
  // only what belongs on this page (a cart has no hero; a product page has reviews)
  const allowed = SECTION_REGISTRY.filter(
    d => d.group === list && sectionAllowedOnPage(d, doc.pageKey)
  );
  // The home page's template group: what this store's look is made of first (as the storefront draws it),
  // then everything else under one heading. Other groups and pages keep the registry order.
  const byFlow = list === 'template' && doc.pageKey === 'home';
  const split = byFlow
    ? orderByFlow(
        allowed.map(d => d.type),
        flowOrder(template, look)
      )
    : { first: allowed.map(d => d.type), more: [] as string[] };
  const defOf = (type: string) => allowed.find(d => d.type === type)!;
  const rows = [...split.first, ...split.more].map(defOf);

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
        <Button variant="ghost" size="sm" type="button" onClick={onClose}>
          {t('close')}
        </Button>
      </div>
      <ul className="grid max-h-[70vh] grid-cols-1 gap-3 overflow-y-auto p-5 sm:grid-cols-2 lg:grid-cols-3">
        {rows.flatMap(d => [
          ...(split.more.length > 0 && d.type === split.more[0] && split.first.length > 0
            ? [
                <li
                  key="more"
                  className="col-span-full pt-2 text-xs font-semibold text-muted-foreground"
                  data-testid="add-section-more"
                >
                  {t('more')}
                </li>,
              ]
            : []),
          ...d.presets.map((p, i) => {
            const full = count(d.type) >= d.maxCount;
            const name = locale === 'ar' ? p.nameAr : p.nameEn;
            return (
              <li key={`${d.type}-${i}`}>
                <button
                  data-ui="tile"
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
          }),
        ])}
      </ul>
    </dialog>
  );
}
