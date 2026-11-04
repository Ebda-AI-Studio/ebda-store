import { Home } from '@/components/Home';
import { pageMetadata } from '@/lib/seo';

// The Ebda Store landing, moved here unchanged from the home (Ruling MKT-HOME-1 / MKT-STORE-FROZEN-1).
export const metadata = pageMetadata('ar', 'store');

export default function Page() {
  return <Home locale="ar" />;
}
