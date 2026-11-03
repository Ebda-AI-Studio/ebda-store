'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from '../../components/StoreLink';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { ShopChrome } from '../../components';
import { useStore, useStoreUrl } from '../../contexts/StoreContext';
import { useLanguage, translations } from '../../contexts/LanguageContext';
import { useCart } from '../../contexts/CartContext';
import { useTemplateComponents } from '../../hooks/useTemplateComponents';
import { useCurrentUrl } from '../../hooks/useCurrentUrl';
import type { TemplateProduct } from '../../templates/types';
import { wishlistToTemplateProduct, type WishlistCardProduct } from '../../templates/adapters';

interface WishlistItem {
  id: string;
  product: WishlistCardProduct;
}

const GUEST_CODES = new Set([
  'UNAUTHORIZED',
  'UNAUTHENTICATED',
  'AUTH_REQUIRED',
  'TOKEN_EXPIRED',
  'INVALID_TOKEN',
  'NO_REFRESH_TOKEN',
]);

export default function WishlistClient() {
  const router = useRouter();
  const storeUrl = useStoreUrl();
  const { t, language } = useLanguage();
  const { store } = useStore();
  const { components: T, isLoading: templateLoading } = useTemplateComponents();
  useCart(); // ensure the cart context is mounted so addToCart writes through
  const [items, setItems] = useState<WishlistItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [isPublic, setIsPublic] = useState(false);
  const [isTogglingVisibility, setIsTogglingVisibility] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const hasFetched = useRef(false);

  // Derive the share URL from the current user's auth state
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  // The page URL is '' until after hydration (useCurrentUrl), so the origin never differs
  // between the server render and the hydrating one.
  const currentUrl = useCurrentUrl();
  const shareUrl =
    currentUserId && currentUrl
      ? `${new URL(currentUrl).origin}${storeUrl(`/wishlist/shared/${currentUserId}`)}`
      : null;

  const loadWishlist = useCallback(async () => {
    setError(null);
    try {
      const response = await api.get<{ items: WishlistItem[]; isPublic: boolean }>('/wishlist');
      if (response.success && response.data) {
        setItems(response.data.items || []);
        setIsPublic(response.data.isPublic ?? false);
      } else if (response.error?.code && GUEST_CODES.has(response.error.code)) {
        // PREMIUM-8: every "you are not signed in" answer is the signed-out empty state, not an error.
        setIsLoggedIn(false);
      } else {
        setError(response.error?.message || t('Failed to load wishlist', 'معرفناش نحمّل المفضلة'));
      }
    } catch (err) {
      console.error('Failed to load wishlist:', err);
      setError(
        t(
          'Unable to load wishlist. Please check your connection.',
          'معرفناش نحمّل المفضلة. اتأكد من اتصالك بالإنترنت.'
        )
      );
    }
    setIsLoading(false);
  }, [t]);

  useEffect(() => {
    if (hasFetched.current) return;
    hasFetched.current = true;

    const checkAuthAndLoad = async () => {
      // Auth is via HTTP-only cookies — try loading the wishlist directly.
      // If the API returns UNAUTHORIZED, loadWishlist handles it.
      setIsLoggedIn(true);
      // Fetch current user ID for share URL
      try {
        const meResponse = await api.get<{ user: { id: string } }>('/auth/me');
        if (meResponse.success && meResponse.data?.user?.id) {
          setCurrentUserId(meResponse.data.user.id);
        }
      } catch {
        // non-critical — share URL just won't render
      }
      await loadWishlist();
    };

    checkAuthAndLoad();
  }, [loadWishlist]);

  async function toggleVisibility() {
    setIsTogglingVisibility(true);
    setActionError(null);
    try {
      const response = await api.put<{ isPublic: boolean }>('/wishlist/visibility', {
        isPublic: !isPublic,
      });
      if (response.success && response.data) {
        setIsPublic(response.data.isPublic);
      } else {
        setActionError('Failed to update wishlist visibility');
      }
    } catch {
      setActionError('Failed to update visibility. Please try again.');
    }
    setIsTogglingVisibility(false);
  }

  async function copyLink() {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setActionError('Failed to copy link');
    }
  }

  function shareOnWhatsApp() {
    if (!shareUrl) return;
    const text = encodeURIComponent(
      t(`Check out my wishlist: ${shareUrl}`, `تفقد قائمة مفضلتي: ${shareUrl}`)
    );
    window.open(`https://wa.me/?text=${text}`, '_blank');
  }

  function shareOnTwitter() {
    if (!shareUrl) return;
    const text = encodeURIComponent(t('Check out my wishlist!', 'تفقد قائمة مفضلتي!'));
    window.open(
      `https://twitter.com/intent/tweet?text=${text}&url=${encodeURIComponent(shareUrl)}`,
      '_blank'
    );
  }

  async function removeFromWishlist(itemId: string) {
    setActionError(null);
    // Optimistic remove — drop from state immediately, roll back on failure.
    const previousItems = items;
    setItems(prev => prev.filter(item => item.id !== itemId));
    try {
      const response = await api.delete(`/wishlist/${itemId}`);
      if (!response.success) {
        setItems(previousItems);
        setActionError('Failed to remove item from wishlist');
      }
    } catch (err) {
      console.error('Failed to remove item:', err);
      setItems(previousItems);
      setActionError('Failed to remove item. Please try again.');
    }
  }

  async function addToCart(productId: string) {
    setActionError(null);
    try {
      const response = await api.addToCart(productId, 1);
      if (response.success) {
        router.push(storeUrl('/cart'));
      } else if (
        response.error?.code === 'PERSONALISATION_REQUIRED' ||
        response.error?.code === 'VARIANT_REQUIRED'
      ) {
        // A personalisation note or a size/colour: both are chosen on the PDP only.
        const slug = items.find(i => i.product.id === productId)?.product.slug;
        if (slug) router.push(storeUrl(`/products/${slug}`));
      } else {
        setActionError(response.error?.message || 'Failed to add to cart');
      }
    } catch (err) {
      console.error('Failed to add to cart:', err);
      setActionError('Failed to add to cart. Please try again.');
    }
  }

  if (isLoading) {
    return (
      <ShopChrome>
        <div className="container mx-auto px-4 py-8 flex-1">
          <h1 className="text-3xl font-bold mb-8">{t('My Wishlist', 'قائمة المفضلة')}</h1>
          <div className="space-y-4">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="bg-muted animate-pulse h-24 rounded-lg"></div>
            ))}
          </div>
        </div>
      </ShopChrome>
    );
  }

  if (!isLoggedIn) {
    return (
      <ShopChrome>
        <div className="container mx-auto px-4 py-8 flex-1">
          <h1 className="text-3xl font-bold mb-8">{t('My Wishlist', 'قائمة المفضلة')}</h1>
          <div className="text-center py-12 bg-muted rounded-xl">
            <svg
              className="w-16 h-16 text-muted-foreground mx-auto mb-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z"
              />
            </svg>
            <h2 className="text-xl font-semibold mb-2">
              {t('Sign in to view your wishlist', 'سجّل دخول عشان تشوف المفضلة')}
            </h2>
            <p className="text-muted-foreground mb-4">
              {t('Save your favorite items for later', 'احفظ المنتجات اللي عاجباك لبعدين')}
            </p>
            <Link
              href={storeUrl('/auth/login?redirect=/wishlist')}
              className="inline-flex items-center px-6 py-3 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90"
            >
              {t('Sign In', translations['Sign In'])}
            </Link>
          </div>
        </div>
      </ShopChrome>
    );
  }

  const wishlistTemplateProducts: TemplateProduct[] = items.map(item =>
    wishlistToTemplateProduct(item.id, item.product)
  );

  const handleAddFromWishlist = async (productId: string) => {
    await addToCart(productId);
  };

  const handleRemoveByProductId = async (productId: string) => {
    const item = items.find(i => i.product.id === productId);
    if (item) await removeFromWishlist(item.id);
  };

  return (
    <ShopChrome>
      <div className="container mx-auto px-4 py-8 flex-1">
        <div className="flex flex-wrap items-center justify-between gap-4 mb-8">
          <h1 className="text-3xl font-bold">{t('My Wishlist', 'قائمة المفضلة')}</h1>

          {/* Visibility toggle */}
          <button
            onClick={toggleVisibility}
            disabled={isTogglingVisibility}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg border text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
              isPublic
                ? 'bg-primary text-primary-foreground border-primary hover:bg-primary/90'
                : 'bg-background text-foreground border-input hover:bg-muted'
            }`}
          >
            {isPublic ? (
              <>
                <svg
                  className="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                  />
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
                  />
                </svg>
                {t('Public', 'عام')}
              </>
            ) : (
              <>
                <svg
                  className="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21"
                  />
                </svg>
                {t('Make Public', 'اجعلها عامة')}
              </>
            )}
          </button>
        </div>

        {/* Share panel (shown when wishlist is public) */}
        {isPublic && shareUrl && (
          <div className="mb-6 p-4 bg-muted rounded-xl">
            <p className="text-sm font-medium mb-3">
              {t('Share your wishlist', 'شارك قائمة مفضلتك')}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              {/* Share URL input */}
              <div className="flex flex-1 min-w-0 items-center gap-2 bg-background border border-input rounded-lg px-3 py-2">
                <span className="text-sm text-muted-foreground truncate flex-1">{shareUrl}</span>
                <button
                  onClick={copyLink}
                  className="flex-shrink-0 text-sm text-primary hover:text-primary/80 font-medium"
                  aria-label={t('Copy link', 'نسخ الرابط')}
                >
                  {copied ? t('Copied!', 'اتنسخ!') : t('Copy', 'نسخ')}
                </button>
              </div>

              {/* WhatsApp */}
              <button
                onClick={shareOnWhatsApp}
                className="flex items-center gap-2 px-3 py-2 bg-[#25D366] text-white rounded-lg text-sm hover:bg-[#1ebe5c] transition-colors"
                aria-label={t('Share on WhatsApp', 'مشاركة عبر واتساب')}
              >
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
                </svg>
                <span className="hidden sm:inline">WhatsApp</span>
              </button>

              {/* Twitter/X */}
              <button
                onClick={shareOnTwitter}
                className="flex items-center gap-2 px-3 py-2 bg-black text-white rounded-lg text-sm hover:bg-foreground transition-colors"
                aria-label={t('Share on X (Twitter)', 'مشاركة عبر X (تويتر)')}
              >
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.743l7.732-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                </svg>
                <span className="hidden sm:inline">X</span>
              </button>
            </div>
          </div>
        )}

        {/* Error Display */}
        {error && (
          <div
            role="alert"
            className="mb-6 p-4 bg-destructive/10 border border-destructive/30 rounded-lg"
          >
            <div className="flex items-center gap-3">
              <svg
                className="h-5 w-5 text-destructive-ink flex-shrink-0"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                />
              </svg>
              <p className="text-destructive-ink flex-1">{error}</p>
              <button
                onClick={() => loadWishlist()}
                className="px-3 py-1 text-sm bg-destructive/20 text-destructive-ink rounded hover:bg-destructive/30 transition-colors"
              >
                Retry
              </button>
            </div>
          </div>
        )}

        {/* Action Error Toast */}
        {actionError && (
          <div role="alert" className="mb-6 p-4 bg-warning/10 border border-warning/30 rounded-lg">
            <div className="flex items-center gap-3">
              <svg
                className="h-5 w-5 text-warning-ink flex-shrink-0"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                />
              </svg>
              <p className="text-warning-ink flex-1">{actionError}</p>
              <button
                onClick={() => setActionError(null)}
                className="p-1 text-warning-ink hover:text-warning-ink/80"
                aria-label={t('Dismiss', 'إغلاق')}
              >
                <svg
                  className="h-4 w-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
                <span className="sr-only">{t('Dismiss', 'إغلاق')}</span>
              </button>
            </div>
          </div>
        )}

        {!error && items.length === 0 ? (
          <div className="text-center py-12 bg-background rounded-lg">
            <svg
              className="w-16 h-16 text-muted-foreground mx-auto mb-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z"
              />
            </svg>
            <h2 className="text-xl font-semibold mb-2">
              {t('Your wishlist is empty', 'المفضلة فاضية')}
            </h2>
            <p className="text-muted-foreground mb-4">
              {t('Start adding products you love!', 'ابدأ ضيف المنتجات اللي بتحبها!')}
            </p>
            <Link
              href={storeUrl('/products')}
              className="inline-flex items-center px-6 py-3 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90"
            >
              {t('Browse Products', 'تصفح المنتجات')}
            </Link>
          </div>
        ) : T && !templateLoading ? (
          <T.ProductGrid
            products={wishlistTemplateProducts}
            isRtl={language === 'ar'}
            currency={store.currency}
            columns={3}
            onAddToCart={handleAddFromWishlist}
            onRemoveFromWishlist={handleRemoveByProductId}
            urlPrefix={storeUrl('')}
          />
        ) : null}
      </div>
    </ShopChrome>
  );
}
