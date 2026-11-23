import { serveCatalogueFeed } from '../../../lib/catalogue-feed-route';

export async function GET(request: Request) {
  return serveCatalogueFeed('google.xml', request);
}
