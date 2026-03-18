import type { Metadata } from 'next';
import dynamic from 'next/dynamic';

const SharedWishlistClient = dynamic(() => import('./SharedWishlistClient'), {
  loading: () => (
    <div className="flex min-h-[50vh] items-center justify-center">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
    </div>
  ),
});

export const metadata: Metadata = {
  title: 'Shared Wishlist',
};

export default function SharedWishlistPage({ params }: { params: { userId: string } }) {
  return <SharedWishlistClient userId={params.userId} />;
}
