'use client';

/**
 * The template gallery (plan F44, F58-F61, F25; Ruling EPUX-3): a sheet over the editor, not a mode of the
 * 320px inspector. One tab per built template family, a card per look with its picture, name and one line of who
 * it is for, the current look marked, and a detail panel with the idea, the colours/fonts choice and "Preview on my
 * page". The registry (`LOOKS`, `status`) is the only source of looks, so a template that ships appears here with no
 * edit. The big live preview is the existing one: the proposal is rendered over the merchant's OWN content in the
 * canvas (`/look/preview`), and nothing is written until Apply.
 * Native <dialog>: focus trap, Escape, focus returns to the button that opened it.
 */
import { Button } from '@/components/ui/Button';
import { navItemClasses } from '@/components/ui/tokens';
import { useEffect, useId, useRef, useState } from 'react';
import { useLocale } from 'next-intl';
import {
  TEMPLATE_FAMILIES,
  builtLookTemplates,
  getLook,
  looksForTemplate,
  type LookId,
  type LookTemplate,
} from '@ebda/shared';
import { useT } from '@/i18n/useT';
import { useRestoreFocus } from '../_lib/use-restore-focus';
import { rovingKeyDown } from '../_lib/roving';
import type { LookDesignChoice } from './LookSwitchPane';

export function TemplateGallery({
  currentLook,
  busy,
  onPreview,
  onClose,
}: {
  currentLook: LookId | null;
  busy: boolean;
  onPreview: (lookId: string, design: LookDesignChoice) => void;
  onClose: () => void;
}) {
  const t = useT('builder.look');
  const locale = useLocale() === 'ar' ? 'ar' : 'en';
  const uid = useId();
  const ref = useRef<HTMLDialogElement>(null);
  useRestoreFocus();
  useEffect(() => {
    ref.current?.showModal();
  }, []);

  const current = getLook(currentLook);
  const tabs: LookTemplate[] = [...builtLookTemplates()];
  if (current && !tabs.includes(current.template)) tabs.push(current.template);
  const [family, setFamily] = useState<LookTemplate>(() => current?.template ?? tabs[0]!);
  const [picked, setPicked] = useState<LookId | null>(null);
  const [design, setDesign] = useState<LookDesignChoice>('keep');

  const familyLabel = (id: LookTemplate) => {
    const f = TEMPLATE_FAMILIES.find(x => x.id === id);
    return f ? (locale === 'ar' ? f.labelAr : f.labelEn) : id;
  };
  const looks = looksForTemplate(family).filter(l => l.status === 'built' || l.id === currentLook);
  const detail = getLook(picked);
  const canPreview = !!picked && picked !== currentLook && !busy;

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={onClose}
      dir={locale === 'ar' ? 'rtl' : 'ltr'}
      aria-labelledby={`${uid}-title`}
      className="m-auto flex max-h-[calc(100dvh-2rem)] w-[min(72rem,calc(100vw-2rem))] flex-col rounded-lg border border-border bg-card p-0 text-foreground shadow-xl backdrop:bg-black/60"
      data-testid="look-switch-pane"
    >
      <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
        <div className="min-w-0">
          <h2 id={`${uid}-title`} className="text-lg font-semibold">
            {t('galleryTitle')}
          </h2>
          <p className="mt-1 text-sm text-muted-ink">{t('galleryIntro')}</p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          type="button"
          onClick={onClose}
          data-testid="gallery-close"
        >
          {t('close')}
        </Button>
      </div>

      <div className="grid min-h-0 flex-1 gap-0 overflow-y-auto lg:grid-cols-[minmax(0,1fr)_20rem] lg:overflow-hidden">
        <div className="min-w-0 space-y-4 p-5 lg:overflow-y-auto">
          <div
            role="tablist"
            aria-label={t('families')}
            onKeyDown={e => rovingKeyDown(e, 'tab')}
            className="flex gap-1 overflow-x-auto rounded-md bg-muted p-1"
          >
            {tabs.map(id => (
              <button
                key={id}
                data-ui="nav"
                type="button"
                role="tab"
                id={`${uid}-tab-${id}`}
                aria-selected={family === id}
                aria-controls={`${uid}-panel`}
                tabIndex={family === id ? 0 : -1}
                onClick={() => setFamily(id)}
                className={navItemClasses({ kind: 'tab', active: family === id })}
              >
                {familyLabel(id)}
              </button>
            ))}
          </div>

          <div
            id={`${uid}-panel`}
            role="radiogroup"
            aria-labelledby={`${uid}-tab-${family}`}
            className="grid grid-cols-2 gap-4 md:grid-cols-3"
          >
            {looks.map(look => {
              const name = look.name[locale];
              const isCurrent = look.id === currentLook;
              const on = picked === look.id;
              return (
                <label
                  key={look.id}
                  className={`group relative flex cursor-pointer flex-col gap-2 rounded-lg border p-2 transition-colors duration-150 focus-within:ring-2 focus-within:ring-ring motion-reduce:transition-none ${
                    on ? 'border-primary bg-primary/10' : 'border-border hover:bg-muted/40'
                  }`}
                >
                  <input
                    type="radio"
                    name={`${uid}-look`}
                    value={look.id}
                    checked={on}
                    onChange={() => setPicked(look.id)}
                    className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                    aria-label={isCurrent ? `${name}, ${t('currentBadge')}` : name}
                  />
                  <span className="relative block">
                    {/* A fixed first-screen crop (360px wide webp); next/image adds nothing for a static asset. */}
                    <img
                      src={`/looks/${look.id}.webp`}
                      alt=""
                      width={360}
                      height={450}
                      loading="lazy"
                      decoding="async"
                      className="aspect-[4/5] w-full rounded-md border border-border bg-muted object-cover object-top"
                    />
                    {isCurrent && (
                      <span className="absolute start-2 top-2 inline-flex h-6 items-center gap-1 rounded-full bg-card px-2 text-xs font-semibold text-primary-ink shadow-sm">
                        <span aria-hidden="true">✓</span>
                        {t('currentBadge')}
                      </span>
                    )}
                  </span>
                  <span className="block text-sm font-semibold">{name}</span>
                  <span className="block text-xs leading-5 text-muted-ink">
                    {look.forWhom[locale]}
                  </span>
                </label>
              );
            })}
          </div>
        </div>

        <aside
          aria-label={t('detailLabel')}
          className="space-y-4 border-t border-border bg-background p-5 lg:overflow-y-auto lg:border-s lg:border-t-0"
          data-testid="gallery-detail"
        >
          {detail ? (
            <>
              <img
                src={`/looks/${detail.id}.webp`}
                alt=""
                width={360}
                height={450}
                className="mx-auto aspect-[4/5] w-full max-w-[16rem] rounded-md border border-border object-cover object-top"
              />
              <div>
                <h3 className="text-base font-semibold">{detail.name[locale]}</h3>
                <p className="mt-1 text-sm text-muted-ink">{detail.idea[locale]}</p>
              </div>
              <fieldset className="space-y-1" disabled={busy}>
                <legend className="mb-1 text-sm font-medium">{t('design')}</legend>
                {(['keep', 'reset'] as const).map(k => (
                  <label
                    key={k}
                    className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md border border-border px-3 text-sm sm:min-h-10"
                  >
                    <input
                      type="radio"
                      name={`${uid}-design`}
                      checked={design === k}
                      onChange={() => setDesign(k)}
                    />
                    <span>{t(k)}</span>
                  </label>
                ))}
              </fieldset>
              <Button
                type="button"
                className="w-full font-semibold"
                disabled={!canPreview}
                onClick={() => picked && onPreview(picked, design)}
                data-testid="look-preview"
              >
                {busy ? t('previewing') : t('previewCta')}
              </Button>
              {picked === currentLook && (
                <p className="text-xs text-muted-ink">{t('alreadyCurrent')}</p>
              )}
              <p className="text-xs leading-5 text-muted-ink">{t('previewNote')}</p>
            </>
          ) : (
            <p className="text-sm text-muted-ink">{t('pickPrompt')}</p>
          )}
        </aside>
      </div>
    </dialog>
  );
}
