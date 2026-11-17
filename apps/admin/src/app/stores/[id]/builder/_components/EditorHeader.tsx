'use client';

/**
 * The editor's top bar, in three groups on ONE row (editor premium F39-F46):
 *   start   back arrow + store name, page menu, (below lg) pane toggles
 *   centre  device switch (icons, width in the tooltip)
 *   end     undo / redo, save pill, Change template, Publish
 * Below 1180px "Change template" moves into the overflow menu; below `sm` undo / redo do too. The row
 * never wraps: it is `flex-nowrap` and every group shrinks by hiding words, not by dropping a line.
 */
import Link from 'next/link';
import type { ReactNode } from 'react';
import {
  ArrowLeft,
  ChevronDown,
  LayoutTemplate,
  Monitor,
  MoreHorizontal,
  PanelLeft,
  PanelRight,
  Redo2,
  Smartphone,
  Tablet,
  Undo2,
} from 'lucide-react';
import type { Viewport } from '@ebda/shared';
import { Button, buttonVariants } from '@/components/ui/Button';
import { useT } from '@/i18n/useT';
import { rovingKeyDown } from '../_lib/roving';
import { useIsMac } from '../_lib/use-is-mac';
import { HeaderPopover } from './HeaderPopover';

type HeaderSaveState = 'loading' | 'saved' | 'dirty' | 'saving' | 'error' | 'conflict';

/** The device widths the canvas uses (BuilderEditor sizes the frame the same way). */
const VIEWPORT_WIDTH: Record<Viewport, number> = { desktop: 1280, tablet: 820, mobile: 390 };

const VIEWPORT_ICON: Record<Viewport, ReactNode> = {
  desktop: <Monitor className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />,
  tablet: <Tablet className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />,
  mobile: <Smartphone className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />,
};

const DOT: Record<HeaderSaveState, string> = {
  loading: 'bg-muted-foreground',
  saved: 'bg-success',
  dirty: 'bg-primary',
  saving: 'bg-primary animate-pulse motion-reduce:animate-none',
  error: 'bg-destructive',
  conflict: 'bg-destructive',
};

/** A CSS tooltip: shown on hover and keyboard focus of the wrapping group, never the only name. */
function Tip({ text, children }: { text: string; children: ReactNode }) {
  return (
    <span className="group relative inline-flex">
      {children}
      <span
        role="tooltip"
        className="pointer-events-none absolute start-1/2 top-full z-50 mt-1 hidden -translate-x-1/2 whitespace-nowrap rounded-md bg-foreground px-2 py-1 text-xs text-background shadow-md group-focus-within:block group-hover:block rtl:translate-x-1/2"
      >
        {text}
      </span>
    </span>
  );
}

export function EditorHeader({
  storeId,
  storeName,
  pageSwitcher,
  viewport,
  onViewport,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  saveState,
  publishing,
  unpublished,
  editCount,
  onPublish,
  showLook,
  lookOpen,
  onOpenLook,
  drawer,
  onToggleDrawer,
}: {
  storeId: string;
  storeName: string;
  pageSwitcher: ReactNode;
  viewport: Viewport;
  onViewport: (v: Viewport) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  saveState: HeaderSaveState;
  publishing: boolean;
  /** The draft differs from what is live. */
  unpublished: boolean;
  /** Edits made in this session (undo steps), shown beside the publish confirm. */
  editCount: number;
  onPublish: () => void;
  showLook: boolean;
  lookOpen: boolean;
  onOpenLook: () => void;
  drawer: 'start' | 'end' | null;
  onToggleDrawer: (side: 'start' | 'end') => void;
}) {
  const t = useT('builder');
  const mac = useIsMac();
  const undoHint = mac ? '⌘Z' : 'Ctrl+Z';
  const redoHint = mac ? '⇧⌘Z' : 'Ctrl+Shift+Z';
  const statusText: Record<HeaderSaveState, string> = {
    loading: t('status.loading'),
    saved: t('status.saved'),
    dirty: t('status.dirty'),
    saving: t('status.saving'),
    error: t('status.error'),
    conflict: t('status.conflict'),
  };

  return (
    <header
      className="flex h-14 shrink-0 flex-nowrap items-center justify-between gap-2 border-b border-border px-3"
      data-testid="editor-header"
    >
      <div className="flex min-w-0 items-center gap-2" data-header-group="start">
        <Link
          href={`/stores/${storeId}`}
          className={buttonVariants({
            variant: 'ghost',
            size: 'sm',
            className: 'max-w-40 gap-1.5 font-semibold max-sm:max-w-24',
          })}
          data-testid="back-link"
        >
          <ArrowLeft
            className="h-4 w-4 shrink-0 rtl:rotate-180"
            strokeWidth={1.75}
            aria-hidden="true"
          />
          <span className="sr-only">{`${t('back')}: `}</span>
          <span className="truncate">{storeName}</span>
        </Link>
        {pageSwitcher}
        <div className="flex gap-0.5 lg:hidden">
          {(['start', 'end'] as const).map(side => (
            <Button
              key={side}
              variant="ghost"
              size="sm"
              type="button"
              onClick={() => onToggleDrawer(side)}
              aria-expanded={drawer === side}
              aria-label={t(`panes.${side}`)}
              className="gap-1.5"
            >
              {side === 'start' ? (
                <PanelLeft
                  className="h-4 w-4 rtl:-scale-x-100"
                  strokeWidth={1.75}
                  aria-hidden="true"
                />
              ) : (
                <PanelRight
                  className="h-4 w-4 rtl:-scale-x-100"
                  strokeWidth={1.75}
                  aria-hidden="true"
                />
              )}
              <span className="max-md:sr-only">{t(`panes.${side}`)}</span>
            </Button>
          ))}
        </div>
      </div>

      <div
        role="radiogroup"
        aria-label={t('viewport.label')}
        onKeyDown={e => rovingKeyDown(e, 'radio')}
        className="hidden shrink-0 items-center gap-0.5 md:inline-flex"
        data-header-group="centre"
      >
        {(['desktop', 'tablet', 'mobile'] as const).map(v => {
          const on = viewport === v;
          const tip = `${t(`viewport.${v}`)} · ${VIEWPORT_WIDTH[v]}px`;
          return (
            <Tip key={v} text={tip}>
              <button
                type="button"
                role="radio"
                aria-checked={on}
                aria-label={tip}
                tabIndex={on ? 0 : -1}
                onClick={() => onViewport(v)}
                data-testid={`viewport-${v}`}
                className={`inline-flex h-8 w-9 items-center justify-center border-b-2 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  on
                    ? 'border-primary text-foreground'
                    : 'border-transparent text-muted-ink hover:text-foreground'
                }`}
              >
                {VIEWPORT_ICON[v]}
              </button>
            </Tip>
          );
        })}
      </div>

      <div className="flex shrink-0 items-center gap-1.5" data-header-group="end">
        <div className="hidden items-center gap-0.5 sm:flex">
          <Tip text={`${t('undo')} · ${undoHint}`}>
            <Button
              variant="ghost"
              size="icon-sm"
              type="button"
              onClick={onUndo}
              disabled={!canUndo}
              aria-label={t('undo')}
              aria-keyshortcuts={mac ? 'Meta+Z' : 'Control+Z'}
              data-testid="undo"
            >
              <Undo2 className="h-4 w-4 rtl:-scale-x-100" strokeWidth={1.75} aria-hidden="true" />
            </Button>
          </Tip>
          <Tip text={`${t('redo')} · ${redoHint}`}>
            <Button
              variant="ghost"
              size="icon-sm"
              type="button"
              onClick={onRedo}
              disabled={!canRedo}
              aria-label={t('redo')}
              aria-keyshortcuts={mac ? 'Meta+Shift+Z' : 'Control+Shift+Z'}
              data-testid="redo"
            >
              <Redo2 className="h-4 w-4 rtl:-scale-x-100" strokeWidth={1.75} aria-hidden="true" />
            </Button>
          </Tip>
        </div>

        <span
          role="status"
          title={statusText[saveState]}
          className="inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-border px-2 text-xs text-muted-foreground"
          data-testid="save-status"
          data-state={saveState}
          data-pill
        >
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${DOT[saveState]}`}
            aria-hidden="true"
            data-dot
          />
          <span className="max-sm:sr-only">{t(`status.short.${saveState}`)}</span>
          <span className="sr-only">{statusText[saveState]}</span>
        </span>

        {showLook && (
          <Button
            variant={lookOpen ? 'soft' : 'outline'}
            size="sm"
            type="button"
            onClick={onOpenLook}
            aria-haspopup="dialog"
            className="hidden gap-1.5 min-[1180px]:inline-flex"
            data-testid="open-look-switch"
            data-setting-id="builder.look-switch"
          >
            <LayoutTemplate className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
            {t('look.open')}
          </Button>
        )}

        <HeaderPopover
          haspopup="menu"
          align="end"
          panelRole="menu"
          panelLabel={t('more')}
          trigger={({ triggerProps }) => (
            <Button
              {...triggerProps}
              variant="ghost"
              size="icon-sm"
              type="button"
              aria-label={t('more')}
              className={showLook ? 'min-[1180px]:hidden' : 'sm:hidden'}
              data-testid="header-overflow"
            >
              <MoreHorizontal className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
            </Button>
          )}
        >
          {({ close }) => (
            <div>
              {showLook && (
                <button
                  type="button"
                  role="menuitem"
                  autoFocus
                  onClick={() => {
                    close();
                    onOpenLook();
                  }}
                  className="flex min-h-8 w-full items-center gap-2 px-3 text-start text-sm hover:bg-muted focus:bg-muted focus:outline-none"
                  data-testid="overflow-look"
                >
                  <LayoutTemplate className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                  {t('look.open')}
                </button>
              )}
              <div className="sm:hidden">
                <button
                  type="button"
                  role="menuitem"
                  disabled={!canUndo}
                  onClick={() => {
                    close();
                    onUndo();
                  }}
                  className="flex min-h-8 w-full items-center gap-2 px-3 text-start text-sm hover:bg-muted focus:bg-muted focus:outline-none disabled:opacity-50"
                >
                  <Undo2
                    className="h-4 w-4 rtl:-scale-x-100"
                    strokeWidth={1.75}
                    aria-hidden="true"
                  />
                  {t('undo')}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={!canRedo}
                  onClick={() => {
                    close();
                    onRedo();
                  }}
                  className="flex min-h-8 w-full items-center gap-2 px-3 text-start text-sm hover:bg-muted focus:bg-muted focus:outline-none disabled:opacity-50"
                >
                  <Redo2
                    className="h-4 w-4 rtl:-scale-x-100"
                    strokeWidth={1.75}
                    aria-hidden="true"
                  />
                  {t('redo')}
                </button>
              </div>
            </div>
          )}
        </HeaderPopover>

        <HeaderPopover
          haspopup="dialog"
          align="end"
          panelRole="dialog"
          panelLabel={t('publish')}
          panelClassName="w-72 p-3"
          trigger={({ triggerProps }) => (
            <Button
              {...triggerProps}
              size="sm"
              type="button"
              disabled={publishing || saveState === 'conflict'}
              className="gap-1.5 font-semibold"
              data-testid="publish-open"
            >
              {publishing ? t('publishing') : t('publish')}
              <ChevronDown className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
            </Button>
          )}
        >
          {({ close }) => (
            <div data-testid="publish-popover">
              <p className="text-sm font-semibold">
                {unpublished ? t('publishPopover.pending') : t('publishPopover.live')}
              </p>
              {unpublished && editCount > 0 && (
                <p className="mt-1 text-sm text-muted-foreground" data-testid="publish-count">
                  {t('publishPopover.count', { count: editCount })}
                </p>
              )}
              <Button
                size="sm"
                type="button"
                autoFocus
                onClick={() => {
                  close();
                  onPublish();
                }}
                disabled={publishing}
                className="mt-3 w-full font-semibold"
                data-testid="publish"
              >
                {t('publishPopover.confirm')}
              </Button>
            </div>
          )}
        </HeaderPopover>
      </div>
    </header>
  );
}
