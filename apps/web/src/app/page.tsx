import { getStoreOrNotFound } from '../lib/store-resolver';
import { HomePageBody } from './HomePageBody';

export default async function HomePage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = (await searchParams) ?? {};
  const draftToken =
    typeof params._layoutDraft === 'string' && params._layoutDraft.length > 0
      ? params._layoutDraft
      : undefined;
  const store = await getStoreOrNotFound();

  return <HomePageBody store={store} draftToken={draftToken} />;
}
