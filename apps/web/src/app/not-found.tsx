import { PlatformLanding } from '../components/PlatformLanding';

/**
 * 404 served by Next when a server-component calls `notFound()`. Most
 * common trigger on this app: an unknown store slug (e.g. /haha) hits
 * `getStoreOrNotFound()` in `lib/store-resolver.ts`. Reuses the
 * platform landing component so users still see what we offer instead
 * of a dead-end error page.
 */
export default function NotFound() {
  return <PlatformLanding notFoundBanner />;
}
