'use client';

/**
 * Dahab header. Desktop: navigation at the inline start, the wordmark centred,
 * search / account / language / bag at the inline end. Phones: menu, wordmark,
 * search and bag; the menu opens a drawer from the inline start and the bag a
 * drawer from the inline end (both mirror in Arabic).
 *
 * Sticky is the page builder's `header.sticky` (ShopChrome owns it); this
 * component only paints the page surface, a hairline and, once the page has
 * scrolled, a translucent backdrop.
 */
import { useEffect, useState } from 'react';
import Link from '../../components/StoreLink';
import type { HeaderProps } from '../types';
import { useTabBarShown, HEADER_MENU_WITH_TAB_BAR } from '../shared/tab-bar-visibility';
import { useLanguage } from '../../contexts/LanguageContext';
import { useNumerals } from '../../hooks/useNumerals';
import { SearchAutocomplete } from '../../components/SearchAutocomplete';
import { resolveLockup } from '@ebda/shared';
import { StoreLogo } from '../shared/StoreLogo';
import { StoreLockup } from '../shared/StoreLockup';
import { useStore } from '../../contexts/StoreContext';
import { DahabDrawer } from './Drawer';
import { DahabCartDrawer } from './CartDrawer';
import { BagIcon, DAHAB_CONTAINER, MenuIcon, SearchIcon, UserIcon, ChevronIcon, cx } from './ui';
import { countText, ITEMS } from '../../lib/plural';

const ICON_BTN =
  'relative flex h-11 w-11 items-center justify-center text-foreground/85 transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm';

export default function DahabHeader({
  branding,
  navigation = [],
  isRtl: isRtlProp,
  cartItemCount = 0,
  onSearch,
  urlPrefix = '',
  headerBgColor,
}: HeaderProps) {
  const { isRtl: ctxIsRtl, language, setLanguage, t } = useLanguage();
  const tabBarShown = useTabBarShown();
  const { store } = useStore();
  const lockup = resolveLockup(store?.theme, store?.look, store?.template);
  const { localize } = useNumerals();
  const isRtl = isRtlProp ?? ctxIsRtl;
  const [menuOpen, setMenuOpen] = useState(false);
  const [bagOpen, setBagOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const name = (isRtl && branding.nameAr ? branding.nameAr : branding.name) || '';
  const logo = isRtl && branding.logoAr ? branding.logoAr : branding.logo;
  const nav = navigation.slice(0, 6);
  const homeHref = urlPrefix || '/';

  const submitSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (onSearch && query.trim()) {
      onSearch(query.trim());
      setSearchOpen(false);
    }
  };

  const wordmark = (
    <Link
      href={homeHref}
      className="flex min-h-11 min-w-11 items-center justify-center rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={name}
    >
      {logo ? (
        <StoreLogo src={logo} alt={name} priority />
      ) : lockup ? (
        <StoreLockup lockup={lockup} name={branding.name} nameAr={branding.nameAr} isRtl={isRtl} />
      ) : (
        <span
          translate="no"
          className="font-display whitespace-nowrap text-[26px] leading-none text-primary sm:text-[30px] rtl:text-[32px] rtl:sm:text-[36px]"
        >
          {name}
        </span>
      )}
    </Link>
  );

  return (
    // The skin's own <header>: the page's one banner landmark (a11y re-audit R1).
    <header
      className={cx(
        'border-b transition-[background-color,border-color] duration-300',
        scrolled ? 'border-border bg-background' : 'border-border/60 bg-background'
      )}
      style={headerBgColor ? { backgroundColor: headerBgColor } : undefined}
      dir={isRtl ? 'rtl' : 'ltr'}
    >
      <div
        className={cx(
          DAHAB_CONTAINER,
          'grid h-16 grid-cols-[1fr_auto_1fr] items-center gap-4 lg:h-[76px]'
        )}
      >
        {/* inline start */}
        <div className="flex items-center gap-1">
          <button
            type="button"
            className={cx(ICON_BTN, '-ms-2.5 lg:hidden', tabBarShown && HEADER_MENU_WITH_TAB_BAR)}
            onClick={() => setMenuOpen(true)}
            aria-label={t('Menu', 'القائمة')}
            aria-expanded={menuOpen}
          >
            <MenuIcon className="h-6 w-6" />
          </button>
          <nav aria-label={t('Main', 'الرئيسية')} className="hidden lg:block">
            <ul className="flex items-center gap-7">
              {nav.map(item => (
                <li key={`${item.href}-${item.label}`}>
                  <Link
                    href={item.href}
                    className="relative inline-flex min-h-11 min-w-11 items-center justify-center py-2 text-[15px] text-foreground/85 transition-colors hover:text-primary after:absolute after:inset-x-0 after:-bottom-0.5 after:h-px after:origin-left after:scale-x-0 after:bg-primary after:transition-transform after:duration-300 hover:after:scale-x-100 rtl:after:origin-right focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
                  >
                    {isRtl && item.labelAr ? item.labelAr : item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </div>

        {wordmark}

        {/* inline end */}
        <div className="flex items-center justify-end gap-0.5 sm:gap-1">
          <button
            type="button"
            className={ICON_BTN}
            onClick={() => setSearchOpen(o => !o)}
            aria-label={t('Search', 'بحث')}
            aria-expanded={searchOpen}
            aria-controls="dahab-search"
          >
            <SearchIcon className="h-[22px] w-[22px]" />
          </button>
          <Link
            href={`${urlPrefix}/account`}
            className={cx(ICON_BTN, 'hidden sm:flex')}
            aria-label={t('Account', 'حسابي')}
          >
            <UserIcon className="h-[22px] w-[22px]" />
          </Link>
          <button
            type="button"
            onClick={() => setLanguage(language === 'ar' ? 'en' : 'ar')}
            className={cx(ICON_BTN, 'hidden w-auto min-w-11 px-2 text-sm lg:flex')}
            aria-label={t('التبديل إلى العربية', 'Switch to English')}
            lang={language === 'ar' ? 'en' : 'ar'}
          >
            {language === 'ar' ? 'EN' : 'عربي'}
          </button>
          <button
            type="button"
            className={cx(ICON_BTN, '-me-2.5')}
            onClick={() => setBagOpen(true)}
            aria-label={
              cartItemCount > 0
                ? t(
                    `Bag, ${countText('en', cartItemCount, ITEMS)}`,
                    `السلة، ${countText('ar', cartItemCount, ITEMS, localize(cartItemCount))}`
                  )
                : t('Bag', 'السلة')
            }
          >
            <BagIcon className="h-[22px] w-[22px]" />
            {cartItemCount > 0 && (
              <span className="absolute end-1 top-1.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-primary px-1 text-xs font-semibold leading-none text-primary-foreground tabular-nums">
                {localize(cartItemCount)}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* Search: a quiet line under the bar, suggestions from the platform search. */}
      <div id="dahab-search" hidden={!searchOpen} className="border-t border-border/60">
        <form
          onSubmit={submitSearch}
          role="search"
          className={cx(DAHAB_CONTAINER, 'relative py-4')}
        >
          <label htmlFor="dahab-search-input" className="sr-only">
            {t('Search the collection', 'ابحث في المجموعة')}
          </label>
          <div className="relative mx-auto max-w-xl">
            <SearchIcon className="pointer-events-none absolute start-0 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" />
            <input
              id="dahab-search-input"
              type="search"
              value={query}
              onChange={e => setQuery(e.target.value)}
              autoFocus={searchOpen}
              placeholder={t('Rings, chains, 21K gold…', 'خواتم، سلاسل، دهب عيار 21…')}
              className="h-12 w-full border-0 border-b border-input bg-transparent ps-8 text-base text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
            />
            <SearchAutocomplete
              query={query}
              onSelect={() => {
                setQuery('');
                setSearchOpen(false);
              }}
            />
          </div>
        </form>
      </div>

      <DahabDrawer
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        side="start"
        label={name || t('Menu', 'القائمة')}
        closeLabel={t('Close menu', 'إغلاق القائمة')}
        footer={
          <div className="flex items-center justify-between">
            <Link
              href={`${urlPrefix}/account`}
              onClick={() => setMenuOpen(false)}
              className="flex min-h-[44px] items-center gap-2 text-sm text-foreground/85 hover:text-primary"
            >
              <UserIcon className="h-5 w-5" />
              {t('My account', 'حسابي')}
            </Link>
            <button
              type="button"
              onClick={() => setLanguage(language === 'ar' ? 'en' : 'ar')}
              className="min-h-[44px] rounded-sm border border-input px-4 text-sm text-foreground/85 hover:border-primary hover:text-primary"
              lang={language === 'ar' ? 'en' : 'ar'}
            >
              {language === 'ar' ? 'English' : 'العربية'}
            </button>
          </div>
        }
      >
        <nav aria-label={t('Menu', 'القائمة')}>
          <ul className="px-5 py-3">
            {nav.map(item => (
              <li
                key={`m-${item.href}-${item.label}`}
                className="border-b border-border/60 last:border-0"
              >
                <Link
                  href={item.href}
                  onClick={() => setMenuOpen(false)}
                  className="font-display flex min-h-[60px] items-center justify-between text-[22px] text-foreground transition-colors hover:text-primary rtl:text-[24px]"
                >
                  {isRtl && item.labelAr ? item.labelAr : item.label}
                  <ChevronIcon className="h-4 w-4 text-primary/70" />
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </DahabDrawer>

      <DahabCartDrawer open={bagOpen} onClose={() => setBagOpen(false)} urlPrefix={urlPrefix} />
    </header>
  );
}
