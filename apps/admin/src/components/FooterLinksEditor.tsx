'use client';

import { useState, useEffect, type ReactNode } from 'react';
import { useToast } from '@ebda/ui';
import { apiGet, apiPut } from '../lib/api';
import { useT } from '@/i18n/useT';
import type { FooterBottomBarSettings } from '@ebda/shared';

/**
 * Reusable footer links + utility bar editor. Extracted from
 * /stores/[id]/pages 2026-05-21 (Ahmad audit: "do it then update memory")
 * so the SAME editor can be rendered:
 *   - standalone at /pages (its own AdminLayout wrapper)
 *   - embedded inside the editor's footer panel
 *
 * The component owns its own state, load, save, and Save button. Both
 * surfaces share one source of truth.
 *
 * Visual rebuild 2026-05-21 night: replaced the 5 box-soup cards with
 * a SectionShell helper that renders a consistent numbered heading,
 * subtitle, "where this shows" hint, optional enable toggle, and body.
 * Link rows use grid layout so each input gets equal share; on narrow
 * widths the AR + EN names share a row and the href drops to its own
 * row instead of competing for horizontal space. Save bar is sticky at
 * the bottom of the editor's scroll region. Bottom Bar section removed
 * (redundant with Company Links).
 */

interface FooterLink {
  name: string;
  nameAr?: string;
  href: string;
  enabled: boolean;
}

interface UtilityBarLink {
  label: string;
  labelAr?: string;
  href: string;
  enabled: boolean;
}

interface UtilityBarSettings {
  enabled?: boolean;
  links?: UtilityBarLink[];
}

interface StoreSettings {
  footerLinks?: {
    shop?: FooterLink[];
    support: FooterLink[];
    company: FooterLink[];
    newsletterEnabled?: boolean;
    /** The footer legal row (S-01): bar switch, per-link toggles, © override.
     *  Saved key by key over what is stored, so a save never drops it. */
    bottomBar?: FooterBottomBarSettings & Record<string, unknown>;
  };
  utilityBar?: UtilityBarSettings;
  [key: string]: unknown;
}

export const DEFAULT_SHOP_LINKS: FooterLink[] = [
  { name: 'All Products', nameAr: 'كل المنتجات', href: '/products', enabled: true },
  { name: 'Categories', nameAr: 'الفئات', href: '/categories', enabled: true },
  { name: 'New Arrivals', nameAr: 'أحدث المنتجات', href: '/products?sort=newest', enabled: true },
  { name: 'Best Sellers', nameAr: 'الأكثر مبيعاً', href: '/products?sort=popular', enabled: true },
  { name: 'On Sale', nameAr: 'العروض', href: '/products?sale=true', enabled: true },
];

export const DEFAULT_SUPPORT_LINKS: FooterLink[] = [
  { name: 'Contact Us', nameAr: 'تواصل معنا', href: '/contact', enabled: true },
  { name: 'FAQ', nameAr: 'الأسئلة الشائعة', href: '/faq', enabled: true },
  { name: 'Shipping Info', nameAr: 'معلومات الشحن', href: '/shipping', enabled: true },
  { name: 'Returns & Refunds', nameAr: 'الإرجاع والاسترداد', href: '/returns', enabled: true },
];

export const DEFAULT_COMPANY_LINKS: FooterLink[] = [
  { name: 'About Us', nameAr: 'من نحن', href: '/about', enabled: true },
  { name: 'Privacy Policy', nameAr: 'سياسة الخصوصية', href: '/privacy', enabled: true },
  { name: 'Terms of Service', nameAr: 'الشروط والأحكام', href: '/terms', enabled: true },
];

export const DEFAULT_UTILITY_LINKS: UtilityBarLink[] = [
  { label: 'Contact', labelAr: 'تواصل معنا', href: '/contact', enabled: true },
  { label: 'Wishlist', labelAr: 'المفضلة', href: '/wishlist', enabled: true },
];

/** Snapshot of current footer-links + utility-bar state for the preview bundle.
 *  `footerLinks` is the same merge a save writes (`mergeFooterLinksForSave` over
 *  what is stored), so the preview keeps stored keys the editor does not edit. */
export interface FooterLinksEditorState {
  footerLinks: {
    shop: FooterLink[];
    support: FooterLink[];
    company: FooterLink[];
    newsletterEnabled: boolean;
    bottomBar: FooterBottomBarSettings & Record<string, unknown>;
    [key: string]: unknown;
  };
  utilityBar: {
    enabled: boolean;
    links: UtilityBarLink[];
  };
}

interface FooterLinksEditorProps {
  storeId: string;
  /** When 'embedded' the editor renders without its outer help banner
   *  (the editor panel already provides context). 'standalone'
   *  shows the full editor as it appears at /pages. */
  variant?: 'standalone' | 'embedded';
  /**
   * When provided, the editor registers a silent save here and HIDES its own
   * Save button — so the visual editor's main Save button persists footer +
   * utility links alongside everything else. Returns true on success.
   */
  saveRef?: React.MutableRefObject<(() => Promise<boolean>) | null>;
  /**
   * Which part to render + save. The utility bar is a TOP-of-page strip, so the
   * the editor mounts it as its own card near the header (`section="utility"`)
   * and the footer link columns + newsletter in the Footer card
   * (`section="links"`). Each instance saves ONLY its own keys (preserving the
   * other via the GET-merge-PUT), so the two cards don't clobber each other —
   * the main Save runs them sequentially. Default 'all' (standalone page).
   */
  section?: 'all' | 'utility' | 'links';
  /**
   * When provided, the editor keeps this ref up-to-date with the current
   * (unsaved) state so the visual editor can include it in the preview-draft
   * bundle without requiring a save first.
   */
  stateRef?: React.MutableRefObject<FooterLinksEditorState | null>;
}

/**
 * The `settings.footerLinks` this editor saves: its own columns + newsletter +
 * legal row laid OVER what is stored. Unknown keys and every bottom-bar key the
 * editor did not touch survive (the 2026-05 version rebuilt the object and
 * wiped `bottomBar` on every save). Exported for its regression test.
 */
export function mergeFooterLinksForSave(
  stored: StoreSettings['footerLinks'] | undefined,
  edited: {
    shop: FooterLink[];
    support: FooterLink[];
    company: FooterLink[];
    newsletterEnabled: boolean;
    bottomBar: FooterBottomBarSettings;
  }
): NonNullable<StoreSettings['footerLinks']> {
  const base = stored && typeof stored === 'object' ? stored : ({} as Record<string, unknown>);
  const storedBar =
    base.bottomBar && typeof base.bottomBar === 'object' && !Array.isArray(base.bottomBar)
      ? base.bottomBar
      : {};
  return { ...base, ...edited, bottomBar: { ...storedBar, ...edited.bottomBar } };
}

/* ── SectionShell ──────────────────────────────────────────────────────
 * One consistent visual frame per editor section. Header carries an
 * ordinal step number, title, subtitle, and an optional enable toggle.
 * `whereShows` is a small footnote-style hint right under the subtitle
 * so merchants know exactly where on the storefront this section paints.
 * Body is the slot for whatever the section configures (link list,
 * etc.). Sticks to the standing admin grouping pattern (`feedback-admin-
 * mirrors-storefront-flow.md`).
 */
function SectionShell({
  step,
  title,
  subtitle,
  whereShows,
  enabled,
  onToggle,
  collapsedWhenDisabled = false,
  embedded = false,
  children,
}: {
  step: number;
  title: string;
  subtitle?: string;
  whereShows?: string;
  enabled?: boolean;
  onToggle?: (value: boolean) => void;
  /** When true + enabled is false, the body doesn't render. */
  collapsedWhenDisabled?: boolean;
  embedded?: boolean;
  children?: ReactNode;
}) {
  const showBody = !collapsedWhenDisabled || enabled !== false;
  return (
    <section
      className={`rounded-xl border ${
        embedded ? 'border-border/60 bg-background' : 'border-border bg-card shadow-sm'
      } overflow-hidden`}
    >
      <header className="flex items-start gap-4 p-5">
        <span
          aria-hidden
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary-ink"
        >
          {step}
        </span>
        <div className="flex-1 min-w-0">
          <h3 className="text-base font-semibold text-foreground leading-tight">{title}</h3>
          {subtitle && (
            <p className="mt-1 text-sm text-muted-foreground leading-snug">{subtitle}</p>
          )}
          {whereShows && (
            <p className="mt-2 text-xs uppercase tracking-wide text-muted-foreground/70">
              {whereShows}
            </p>
          )}
        </div>
        {typeof enabled === 'boolean' && onToggle && (
          <label className="relative inline-flex items-center cursor-pointer shrink-0 mt-0.5">
            <input
              type="checkbox"
              checked={enabled}
              onChange={e => onToggle(e.target.checked)}
              className="sr-only peer"
            />
            <div className="w-11 h-6 bg-muted peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-primary/20 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-border after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary" />
          </label>
        )}
      </header>
      {showBody && children && (
        <div className="border-t border-border/60 bg-muted/20 p-5">{children}</div>
      )}
    </section>
  );
}

/* ── LinkRow ───────────────────────────────────────────────────────────
 * One editable footer-link row. Responsive grid: 2 columns (name EN /
 * name AR) on narrow widths with the path on a second row; 4 columns
 * inline on md+. Enable checkbox + delete button anchor the start +
 * end. Used by every link list (shop / support / company / utility).
 */
function LinkRow({
  enabled,
  primaryLabel,
  primaryValue,
  primaryPlaceholder,
  arabicValue,
  arabicPlaceholder,
  pathValue,
  pathPlaceholder,
  onToggle,
  onPrimaryChange,
  onArabicChange,
  onPathChange,
  onRemove,
  removeTitle,
}: {
  enabled: boolean;
  primaryLabel: string;
  primaryValue: string;
  primaryPlaceholder: string;
  arabicValue: string;
  arabicPlaceholder: string;
  pathValue: string;
  pathPlaceholder: string;
  onToggle: (v: boolean) => void;
  onPrimaryChange: (v: string) => void;
  onArabicChange: (v: string) => void;
  onPathChange: (v: string) => void;
  onRemove: () => void;
  removeTitle: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-3 transition-colors hover:border-border/80">
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={enabled}
          onChange={e => onToggle(e.target.checked)}
          className="mt-2.5 h-4 w-4 shrink-0 rounded border-border text-primary focus:ring-primary"
          aria-label={primaryLabel}
        />
        <div className="flex-1 min-w-0 grid grid-cols-1 sm:grid-cols-2 gap-2">
          <input
            type="text"
            value={primaryValue}
            onChange={e => onPrimaryChange(e.target.value)}
            placeholder={primaryPlaceholder}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <input
            type="text"
            value={arabicValue}
            onChange={e => onArabicChange(e.target.value)}
            placeholder={arabicPlaceholder}
            lang="ar"
            dir="rtl"
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <input
            type="text"
            value={pathValue}
            onChange={e => onPathChange(e.target.value)}
            placeholder={pathPlaceholder}
            className="sm:col-span-2 w-full rounded-md border border-border bg-background px-3 py-2 text-sm font-mono text-muted-foreground focus:border-primary focus:text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
        <button
          type="button"
          onClick={onRemove}
          className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-destructive/5 hover:text-destructive transition-colors"
          title={removeTitle}
          aria-label={removeTitle}
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}

/* ── AddLinkButton ────────────────────────────────────────────────────
 * Full-width "+ Add link" affordance at the bottom of every list.
 * Dashed border ghost button — friendlier and more discoverable than
 * the cramped + icon previously crammed into each section heading.
 */
function AddLinkButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center justify-center gap-2 rounded-lg border-2 border-dashed border-border bg-transparent px-3 py-2.5 text-sm font-medium text-muted-foreground hover:border-primary hover:text-primary transition-colors"
    >
      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
      </svg>
      {label}
    </button>
  );
}

export function FooterLinksEditor({
  storeId,
  variant = 'standalone',
  saveRef,
  section = 'all',
  stateRef,
}: FooterLinksEditorProps) {
  const t = useT('pages.page');
  const { success, error: showError } = useToast();
  const isEmbedded = variant === 'embedded';

  const [isSaving, setIsSaving] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [shopLinks, setShopLinks] = useState<FooterLink[]>(DEFAULT_SHOP_LINKS);
  const [supportLinks, setSupportLinks] = useState<FooterLink[]>(DEFAULT_SUPPORT_LINKS);
  const [companyLinks, setCompanyLinks] = useState<FooterLink[]>(DEFAULT_COMPANY_LINKS);
  const [newsletterEnabled, setNewsletterEnabled] = useState(true);
  // The footer legal row (S-01). Unset keys keep the storefront default (on).
  const [bottomBar, setBottomBar] = useState<FooterBottomBarSettings>({});
  // What is stored, as loaded: the preview bundle lays the edits over it, as a save does.
  const [storedFooterLinks, setStoredFooterLinks] = useState<StoreSettings['footerLinks']>();
  const [utilityBarEnabled, setUtilityBarEnabled] = useState(true);
  const [utilityLinks, setUtilityLinks] = useState<UtilityBarLink[]>(DEFAULT_UTILITY_LINKS);

  useEffect(() => {
    let cancelled = false;
    async function loadSettings() {
      try {
        const { data } = await apiGet<{ store: { settings: StoreSettings } }>(
          `/api/v1/stores/${storeId}`
        );
        if (cancelled) return;
        if (data?.store) {
          const settings = (data.store.settings || {}) as StoreSettings;
          if (settings.footerLinks) {
            setStoredFooterLinks(settings.footerLinks);
            if (settings.footerLinks.shop?.length) setShopLinks(settings.footerLinks.shop);
            if (settings.footerLinks.support?.length) setSupportLinks(settings.footerLinks.support);
            if (settings.footerLinks.company?.length) setCompanyLinks(settings.footerLinks.company);
            if (typeof settings.footerLinks.newsletterEnabled === 'boolean') {
              setNewsletterEnabled(settings.footerLinks.newsletterEnabled);
            }
            const bb = settings.footerLinks.bottomBar;
            if (bb && typeof bb === 'object' && !Array.isArray(bb)) {
              const next: FooterBottomBarSettings = {};
              for (const k of [
                'enabled',
                'privacyEnabled',
                'termsEnabled',
                'shippingEnabled',
                'returnsEnabled',
              ] as const)
                if (typeof bb[k] === 'boolean') next[k] = bb[k];
              for (const k of ['copyrightOverride', 'copyrightOverrideAr'] as const)
                if (typeof bb[k] === 'string') next[k] = bb[k];
              setBottomBar(next);
            }
          }
          if (settings.utilityBar) {
            const ub = settings.utilityBar;
            if (typeof ub.enabled === 'boolean') setUtilityBarEnabled(ub.enabled);
            if (Array.isArray(ub.links)) {
              const cleaned = ub.links
                .filter(
                  (item): item is UtilityBarLink =>
                    !!item &&
                    typeof item === 'object' &&
                    typeof (item as { label?: unknown }).label === 'string' &&
                    typeof (item as { href?: unknown }).href === 'string'
                )
                .map(item => ({
                  label: item.label,
                  labelAr: typeof item.labelAr === 'string' ? item.labelAr : undefined,
                  href: item.href,
                  enabled: typeof item.enabled === 'boolean' ? item.enabled : true,
                }));
              if (cleaned.length) setUtilityLinks(cleaned);
            }
          }
        }
      } catch {
        // Silent — defaults remain in state.
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }
    void loadSettings();
    return () => {
      cancelled = true;
    };
  }, [storeId]);

  // Keep stateRef in sync with live editor state so the editor can read
  // the current (unsaved) values for the preview-draft bundle.
  useEffect(() => {
    if (stateRef) {
      const edited = {
        shop: shopLinks,
        support: supportLinks,
        company: companyLinks,
        newsletterEnabled,
        bottomBar,
      };
      const merged = mergeFooterLinksForSave(storedFooterLinks, edited);
      stateRef.current = {
        footerLinks: { ...merged, ...edited, bottomBar: merged.bottomBar ?? {} },
        utilityBar: {
          enabled: utilityBarEnabled,
          links: utilityLinks,
        },
      };
    }
  }, [
    shopLinks,
    supportLinks,
    companyLinks,
    newsletterEnabled,
    bottomBar,
    storedFooterLinks,
    utilityBarEnabled,
    utilityLinks,
    stateRef,
  ]);

  async function handleSave(opts?: { silent?: boolean }): Promise<boolean> {
    // A unified (silent) save fired before this editor finished loading would
    // persist DEFAULT links over the merchant's real ones — skip until loaded.
    if (opts?.silent && isLoading) return true;
    setIsSaving(true);
    try {
      const { data: getData } = await apiGet<{ store: { settings: StoreSettings } }>(
        `/api/v1/stores/${storeId}`
      );
      const currentSettings = (getData?.store?.settings || {}) as StoreSettings;
      // Each instance writes ONLY the keys for its section so two cards (utility
      // near the header, links in the footer) never clobber each other — the
      // rest is preserved from the fresh GET above.
      const newSettings: StoreSettings = { ...currentSettings };
      if (section !== 'utility') {
        newSettings.footerLinks = mergeFooterLinksForSave(currentSettings.footerLinks, {
          shop: shopLinks,
          support: supportLinks,
          company: companyLinks,
          newsletterEnabled,
          bottomBar,
        });
      }
      if (section !== 'links') {
        newSettings.utilityBar = {
          enabled: utilityBarEnabled,
          links: utilityLinks
            .filter(link => link.label.trim() && link.href.trim())
            .map(link => ({
              label: link.label.trim(),
              labelAr: link.labelAr?.trim() || undefined,
              href: link.href.trim(),
              enabled: link.enabled,
            })),
        };
      }
      const { error: saveError } = await apiPut(`/api/v1/stores/${storeId}`, {
        settings: newSettings,
      });
      if (!saveError) {
        if (!opts?.silent) success(t('toastSavedTitle'), t('toastSavedBody'));
        return true;
      }
      showError(t('toastErrorTitle'), saveError.message || t('toastFailedSave'));
      return false;
    } catch {
      showError(t('toastErrorTitle'), t('toastFailedSaveLinks'));
      return false;
    } finally {
      setIsSaving(false);
    }
  }

  // Register a silent save for the visual editor's main Save button.
  if (saveRef) saveRef.current = () => handleSave({ silent: true });

  function getSetter(section: 'shop' | 'support' | 'company') {
    if (section === 'shop') return setShopLinks;
    if (section === 'support') return setSupportLinks;
    return setCompanyLinks;
  }
  function updateLink(
    section: 'shop' | 'support' | 'company',
    index: number,
    field: keyof FooterLink,
    value: string | boolean
  ) {
    getSetter(section)(prev =>
      prev.map((link, i) => (i === index ? { ...link, [field]: value } : link))
    );
  }
  function addLink(section: 'shop' | 'support' | 'company') {
    getSetter(section)(prev => [...prev, { name: '', href: '/', enabled: true }]);
  }
  function removeLink(section: 'shop' | 'support' | 'company', index: number) {
    getSetter(section)(prev => prev.filter((_, i) => i !== index));
  }
  function updateUtilityLink(index: number, field: keyof UtilityBarLink, value: string | boolean) {
    setUtilityLinks(prev =>
      prev.map((link, i) => (i === index ? { ...link, [field]: value } : link))
    );
  }
  function addUtilityLink() {
    setUtilityLinks(prev => [...prev, { label: '', href: '/', enabled: true }]);
  }
  function removeUtilityLink(index: number) {
    setUtilityLinks(prev => prev.filter((_, i) => i !== index));
  }

  // One-click helpers: insert a Locations link into the relevant list when
  // not already present. The merchant placed it by choice — they can edit/
  // remove it like any other link.
  function addLocationsFooterLink(section: 'shop' | 'support' | 'company') {
    const links =
      section === 'shop' ? shopLinks : section === 'support' ? supportLinks : companyLinks;
    if (links.some(l => l.href === '/locations')) return;
    getSetter(section)(prev => [
      ...prev,
      { name: 'Locations', nameAr: 'الفروع', href: '/locations', enabled: true },
    ]);
  }
  function addLocationsUtilityLink() {
    if (utilityLinks.some(l => l.href === '/locations')) return;
    setUtilityLinks(prev => [
      ...prev,
      { label: 'Locations', labelAr: 'الفروع', href: '/locations', enabled: true },
    ]);
  }

  function renderLinkList(section: 'shop' | 'support' | 'company', links: FooterLink[]): ReactNode {
    const hasLocations = links.some(l => l.href === '/locations');
    return (
      <div className="space-y-3">
        {links.length === 0 ? (
          <p className="text-muted-foreground text-sm py-2 text-center">{t('emptyLinks')}</p>
        ) : (
          links.map((link, index) => (
            <LinkRow
              key={index}
              enabled={link.enabled}
              primaryLabel={t('linkNamePlaceholder')}
              primaryValue={link.name}
              primaryPlaceholder={t('linkNamePlaceholder')}
              arabicValue={link.nameAr || ''}
              arabicPlaceholder={t('linkNameArPlaceholder')}
              pathValue={link.href}
              pathPlaceholder={t('linkPathPlaceholder')}
              onToggle={v => updateLink(section, index, 'enabled', v)}
              onPrimaryChange={v => updateLink(section, index, 'name', v)}
              onArabicChange={v => updateLink(section, index, 'nameAr', v)}
              onPathChange={v => updateLink(section, index, 'href', v)}
              onRemove={() => removeLink(section, index)}
              removeTitle={t('removeLink')}
            />
          ))
        )}
        <AddLinkButton label={t('addLink')} onClick={() => addLink(section)} />
        {!hasLocations && (
          <AddLinkButton
            label={t('addLocationsLink')}
            onClick={() => addLocationsFooterLink(section)}
          />
        )}
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Section 1 — Utility Bar (top of every page). Rendered alone when
          section="utility" (its own card near the header). */}
      {section !== 'links' && (
        <SectionShell
          step={1}
          title={t('utilityBar')}
          subtitle={t('utilityBarHint')}
          whereShows={isEmbedded ? undefined : t('utilityBarWhere')}
          enabled={utilityBarEnabled}
          onToggle={setUtilityBarEnabled}
          collapsedWhenDisabled
          embedded={isEmbedded}
        >
          <div className="space-y-3">
            {utilityLinks.length === 0 ? (
              <p className="text-muted-foreground text-sm py-2 text-center">{t('emptyLinks')}</p>
            ) : (
              utilityLinks.map((link, index) => (
                <LinkRow
                  key={index}
                  enabled={link.enabled}
                  primaryLabel={t('utilityBarLabelPlaceholder')}
                  primaryValue={link.label}
                  primaryPlaceholder={t('utilityBarLabelPlaceholder')}
                  arabicValue={link.labelAr || ''}
                  arabicPlaceholder={t('utilityBarLabelArPlaceholder')}
                  pathValue={link.href}
                  pathPlaceholder={t('linkPathPlaceholder')}
                  onToggle={v => updateUtilityLink(index, 'enabled', v)}
                  onPrimaryChange={v => updateUtilityLink(index, 'label', v)}
                  onArabicChange={v => updateUtilityLink(index, 'labelAr', v)}
                  onPathChange={v => updateUtilityLink(index, 'href', v)}
                  onRemove={() => removeUtilityLink(index)}
                  removeTitle={t('removeLink')}
                />
              ))
            )}
            <AddLinkButton label={t('addLink')} onClick={addUtilityLink} />
            {!utilityLinks.some(l => l.href === '/locations') && (
              <AddLinkButton label={t('addLocationsLink')} onClick={addLocationsUtilityLink} />
            )}
          </div>
        </SectionShell>
      )}

      {/* Sections 2–5 — footer link columns + newsletter. Hidden when this
          instance only renders the utility bar. */}
      {section !== 'utility' && (
        <>
          {/* Section 2 — Shop links (first footer column) */}
          <SectionShell
            step={2}
            title={t('shopLinks')}
            subtitle={t('shopLinksHint')}
            whereShows={isEmbedded ? undefined : t('shopLinksWhere')}
            embedded={isEmbedded}
          >
            {renderLinkList('shop', shopLinks)}
          </SectionShell>

          {/* Section 3 — Support links (second footer column) */}
          <SectionShell
            step={3}
            title={t('supportLinks')}
            subtitle={t('supportLinksHint')}
            whereShows={isEmbedded ? undefined : t('supportLinksWhere')}
            embedded={isEmbedded}
          >
            {renderLinkList('support', supportLinks)}
          </SectionShell>

          {/* Section 4 — Company links (third footer column) */}
          <SectionShell
            step={4}
            title={t('companyLinks')}
            subtitle={t('companyLinksHint')}
            whereShows={isEmbedded ? undefined : t('companyLinksWhere')}
            embedded={isEmbedded}
          >
            {renderLinkList('company', companyLinks)}
          </SectionShell>

          {/* Section 5 — Newsletter (subscribe form below footer columns) */}
          <SectionShell
            step={5}
            title={t('newsletter')}
            subtitle={t('newsletterHint')}
            whereShows={isEmbedded ? undefined : t('newsletterWhere')}
            enabled={newsletterEnabled}
            onToggle={setNewsletterEnabled}
            embedded={isEmbedded}
          />
        </>
      )}

      {/* Section 6 — the footer legal row (S-01): privacy · terms · returns · ©. */}
      {section !== 'utility' && (
        <SectionShell
          step={6}
          title={t('legalRow')}
          subtitle={t('legalRowHint')}
          whereShows={isEmbedded ? undefined : t('legalRowWhere')}
          enabled={bottomBar.enabled !== false}
          onToggle={v => setBottomBar(b => ({ ...b, enabled: v }))}
          collapsedWhenDisabled
          embedded={isEmbedded}
        >
          <div className="space-y-3">
            {(
              [
                ['privacyEnabled', 'legalRowPrivacy'],
                ['termsEnabled', 'legalRowTerms'],
                ['returnsEnabled', 'legalRowReturns'],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="flex items-center gap-3 text-sm text-foreground">
                <input
                  type="checkbox"
                  checked={bottomBar[key] !== false}
                  onChange={e => setBottomBar(b => ({ ...b, [key]: e.target.checked }))}
                  className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
                />
                {t(label)}
              </label>
            ))}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <input
                type="text"
                value={bottomBar.copyrightOverride ?? ''}
                maxLength={200}
                onChange={e => setBottomBar(b => ({ ...b, copyrightOverride: e.target.value }))}
                placeholder={t('legalRowCopyrightPlaceholder')}
                aria-label={t('legalRowCopyrightPlaceholder')}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              />
              <input
                type="text"
                value={bottomBar.copyrightOverrideAr ?? ''}
                maxLength={200}
                onChange={e => setBottomBar(b => ({ ...b, copyrightOverrideAr: e.target.value }))}
                placeholder={t('legalRowCopyrightArPlaceholder')}
                aria-label={t('legalRowCopyrightArPlaceholder')}
                lang="ar"
                dir="rtl"
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
          </div>
        </SectionShell>
      )}

      {/* Sticky save bar — anchored at the bottom of the editor's flow
          (not the viewport) so it doesn't fight the editor's own
          sticky chrome when embedded. Pinned position inside the
          standalone /pages variant comes from the page-level sticky
          footer there, not from this component. */}
      {/* Hidden when the visual editor owns saving (saveRef provided) — the
          main Save button persists footer + utility links via the registered
          saver. Otherwise the standalone editor keeps its own sticky save. */}
      {!saveRef && (
        <div className="sticky bottom-0 -mx-1 mt-2 flex items-center justify-end gap-3 rounded-xl border border-border/60 bg-card/95 px-4 py-3 shadow-md backdrop-blur supports-[backdrop-filter]:bg-card/85">
          <p className="text-xs text-muted-foreground hidden sm:block">{t('saveHintEmpty')}</p>
          <button
            type="button"
            onClick={() => handleSave()}
            disabled={isSaving}
            className="flex items-center gap-2 rounded-lg bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60 transition-colors"
          >
            {isSaving && (
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
            )}
            {isSaving ? t('saving') : t('saveChanges')}
          </button>
        </div>
      )}
    </div>
  );
}
